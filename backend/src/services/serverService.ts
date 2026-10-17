import { randomBytes } from 'node:crypto';
import { execute, query, queryOne, tx, type Queryable } from '../db/pool.js';
import { Errors, AppError } from '../http/errors.js';
import { ALL_PERMISSIONS, ADMIN_PERMS, DEFAULT_MEMBER_PERMS, MODERATOR_PERMS, Perm, has } from '../models/permissions.js';
import * as repo from '../repositories/serverRepo.js';
import { loadPublicUser } from '../repositories/userRepo.js';
import { getAccess, requireMember, requirePerm, requireManageableMember, type MemberAccess } from './permissionService.js';
import { audit, AuditAction } from './auditService.js';
import { control, emit } from '../websocket/bus.js';
import { Ev } from '../websocket/events.js';
import { deleteMedia, storeProcessedImage } from './mediaService.js';
import { voiceStatesForServer,forceDisconnectUser,statesForChannels,syncVoicePermissions } from './voiceService.js';
import { postSystem } from './messageService.js';
import type { ChannelDTO } from '../models/dto.js';

export async function listMine(userId: string) {
  return (await repo.serversOfUser(userId)).map(repo.toServer);
}

/** Everything the client needs to render a server: channels, roles, members, voice occupancy, own permissions. */
export async function getFull(serverId: string, userId: string) {
  const access = await requireMember(serverId, userId);
  const [server, channels, roles, members, voice] = await Promise.all([
    repo.findServer(serverId),
    repo.channelsOf(serverId),
    repo.rolesOf(serverId),
    repo.loadMembers(serverId),
    voiceStatesForServer(serverId),
  ]);
  return {
    server: repo.toServer(server!),
    channels: channels.map(repo.toChannel),
    roles: roles.map(repo.toRole),
    members,
    voiceStates: voice,
    permissions: access.perms.toString(),
  };
}

export async function create(userId: string, input: { name: string; description?: string; isPublic?: boolean }) {
  const serverId = await tx(async (db) => {
    const s = await queryOne<{ id: string }>(
      `INSERT INTO servers (name, description, owner_id, is_public) VALUES ($1, $2, $3, $4) RETURNING id`,
      [input.name.trim(), input.description ?? '', userId, input.isPublic ?? false],
      db,
    );
    const id = s!.id;
    await execute(
      `INSERT INTO roles (server_id, name, color, permissions, position, is_default) VALUES
         ($1, 'Member', NULL, $2, 0, true),
         ($1, 'Moderator', '#3ba55d', $3, 1, false),
         ($1, 'Admin', '#e5484d', $4, 2, false)`,
      [id, DEFAULT_MEMBER_PERMS.toString(), MODERATOR_PERMS.toString(), ADMIN_PERMS.toString()],
      db,
    );
    await execute(`INSERT INTO server_members (server_id, user_id) VALUES ($1, $2)`, [id, userId], db);
    await execute(
      `INSERT INTO channels (server_id, type, name, category, position) VALUES
         ($1, 'text', 'general', 'Текстовые каналы', 0),
         ($1, 'voice', 'General', 'Голосовые каналы', 0)`,
      [id],
      db,
    );
    return id;
  });
  await control({ kind: 'subscribe', userId, serverId });
  const full = await getFull(serverId, userId);
  await emit(Ev.ServerCreate, full, { users: [userId] });
  return full;
}

export async function update(
  serverId: string,
  userId: string,
  patch: { name?: string; description?: string; isPublic?: boolean },
) {
  await requirePerm(serverId, userId, Perm.MANAGE_SERVER);
  await execute(
    `UPDATE servers SET name = coalesce($2, name), description = coalesce($3, description), is_public = coalesce($4, is_public) WHERE id = $1`,
    [serverId, patch.name?.trim() ?? null, patch.description ?? null, patch.isPublic ?? null],
  );
  await audit(serverId, userId, AuditAction.ServerUpdate, { type: 'server', id: serverId }, patch);
  return broadcastServer(serverId);
}

async function broadcastServer(serverId: string) {
  const dto = repo.toServer((await repo.findServer(serverId))!);
  await emit(Ev.ServerUpdate, dto, { server: serverId });
  return dto;
}

export async function setImage(serverId: string, userId: string, field: 'icon' | 'banner', data: Buffer | null) {
  await requirePerm(serverId, userId, Perm.MANAGE_SERVER);
  const column = field === 'icon' ? 'icon_key' : 'banner_key';
  const old = await queryOne<{ key: string | null }>(`SELECT ${column} AS key FROM servers WHERE id = $1`, [serverId]);
  const key = data ? await storeProcessedImage(data, field === 'icon' ? 'icon' : 'server-banner') : null;
  await execute(`UPDATE servers SET ${column} = $2 WHERE id = $1`, [serverId, key]);
  await deleteMedia(old?.key);
  await audit(serverId, userId, AuditAction.ServerUpdate, { type: 'server', id: serverId }, { [field]: key ? 'changed' : 'removed' });
  return broadcastServer(serverId);
}

export async function remove(serverId: string, userId: string): Promise<void> {
  const access = await requireMember(serverId, userId);
  if (!access.isOwner) throw Errors.forbidden('Удалить сервер может только владелец');
  const members = await repo.memberIds(serverId);
  const server = await repo.findServer(serverId);
  for(const state of await voiceStatesForServer(serverId))await forceDisconnectUser(state.userId,serverId,state.channelId);
  await execute(`DELETE FROM servers WHERE id = $1`, [serverId]);
  await Promise.all([deleteMedia(server?.icon_key), deleteMedia(server?.banner_key)]);
  await emit(Ev.ServerDelete, { id: serverId }, { users: members });
  await Promise.all(members.map((m) => control({ kind: 'unsubscribe', userId: m, serverId })));
}

async function removeMember(serverId: string, targetId: string, reason: 'leave' | 'kick' | 'ban'): Promise<void> {
  const removed=await tx(async db=>{
    await lockMembership(db,serverId,targetId);
    return execute(`DELETE FROM server_members WHERE server_id=$1 AND user_id=$2`,[serverId,targetId],db);
  });
  if(removed)await finishRemoveMember(serverId,targetId,reason);
}

async function lockMembership(db:Queryable,serverId:string,userId:string):Promise<void>{
  await execute(`SELECT pg_advisory_xact_lock(hashtextextended($1,0))`,[`membership:${serverId}:${userId}`],db);
}

async function finishRemoveMember(serverId:string,targetId:string,reason:'leave'|'kick'|'ban'):Promise<void>{
  await forceDisconnectUser(targetId, serverId).catch(() => undefined);
  await emit(Ev.MemberLeave, { serverId, userId: targetId, reason }, { server: serverId });
  await emit(Ev.ServerRemoved, { id: serverId, reason }, { users: [targetId] });
  await control({ kind: 'unsubscribe', userId: targetId, serverId });
}

export async function leave(serverId: string, userId: string): Promise<void> {
  const access = await requireMember(serverId, userId);
  if (access.isOwner) throw Errors.conflict('OWNER_CANNOT_LEAVE', 'Владелец не может покинуть сервер — удалите его или передайте права');
  await removeMember(serverId, userId, 'leave');
}

/** Adds a user as a member (invite/discovery). Banned users are refused. */
async function join(serverId: string, userId: string) {
  const inserted=await tx(async db=>{
  await lockMembership(db,serverId,userId);
  const banned = await queryOne(`SELECT 1 FROM bans WHERE server_id = $1 AND user_id = $2`, [serverId, userId],db);
  if (banned) throw Errors.forbidden('Вы заблокированы на этом сервере');
  const inserted = await execute(
    `INSERT INTO server_members (server_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
    [serverId, userId],
    db,
  );
  return inserted;
  });
  return finishJoin(serverId, userId, inserted > 0);
}

/** Broadcast only after membership and invite accounting have committed together. */
async function finishJoin(serverId: string, userId: string, inserted: boolean) {
  if (inserted) {
    await control({ kind: 'subscribe', userId, serverId });
    const [member] = await repo.loadMembers(serverId, [userId]);
    if(member)await emit(Ev.MemberJoin, member, { server: serverId });
    const first = await queryOne<{ id: string }>(
      `SELECT id FROM channels WHERE server_id = $1 AND type = 'text' ORDER BY position, created_at LIMIT 1`,
      [serverId],
    );
    if (first) await postSystem(first.id, userId, 'joined');
  }
  const full = await getFull(serverId, userId);
  if (inserted) await emit(Ev.ServerCreate, full, { users: [userId] });
  return full;
}

// ─────────────── hierarchy helpers ───────────────

async function targetTop(serverId: string, targetId: string,db?:Queryable): Promise<{ top: number; isOwner: boolean }> {
  const t = await getAccess(serverId, targetId,db);
  if (!t) throw Errors.notFound('Участник');
  return { top: t.topPosition, isOwner: t.isOwner };
}

async function assertAbove(actor: MemberAccess, serverId: string, targetId: string, actorId: string,db?:Queryable): Promise<void> {
  if (actorId === targetId) throw Errors.badRequest('Нельзя применить это действие к себе');
  const t = await targetTop(serverId, targetId,db);
  if (t.isOwner) throw Errors.forbidden('Нельзя модерировать владельца сервера');
  if (!actor.isOwner && actor.topPosition <= t.top) throw Errors.forbidden('Роль участника выше или равна вашей');
}

// ─────────────── moderation ───────────────

export async function kick(serverId: string, actorId: string, targetId: string, reason?: string): Promise<void> {
  const actor = await requirePerm(serverId, actorId, Perm.KICK_MEMBERS);
  await assertAbove(actor, serverId, targetId, actorId);
  await removeMember(serverId, targetId, 'kick');
  await audit(serverId, actorId, AuditAction.MemberKick, { type: 'user', id: targetId }, { reason });
}

export async function ban(serverId: string, actorId: string, targetId: string, reason?: string): Promise<void> {
  const actor = await requirePerm(serverId, actorId, Perm.BAN_MEMBERS);
  const removed=await tx(async db=>{
  await lockMembership(db,serverId,targetId);
  const isMember = await getAccess(serverId, targetId,db);
  if (isMember) await assertAbove(actor, serverId, targetId, actorId,db);
  else if (!(await queryOne(`SELECT 1 FROM users WHERE id=$1`,[targetId],db))) throw Errors.notFound('Пользователь');
  await execute(
    `INSERT INTO bans (server_id, user_id, reason, banned_by) VALUES ($1, $2, $3, $4) ON CONFLICT (server_id, user_id) DO UPDATE SET reason = EXCLUDED.reason`,
    [serverId, targetId, reason ?? null, actorId],
    db,
  );
  return execute(`DELETE FROM server_members WHERE server_id=$1 AND user_id=$2`,[serverId,targetId],db);
  });
  if(removed)await finishRemoveMember(serverId,targetId,'ban');
  await audit(serverId, actorId, AuditAction.MemberBan, { type: 'user', id: targetId }, { reason });
}

export async function unban(serverId: string, actorId: string, targetId: string): Promise<void> {
  await requirePerm(serverId, actorId, Perm.BAN_MEMBERS);
  await tx(async db=>{await lockMembership(db,serverId,targetId);await execute(`DELETE FROM bans WHERE server_id=$1 AND user_id=$2`,[serverId,targetId],db);});
  await audit(serverId, actorId, AuditAction.MemberUnban, { type: 'user', id: targetId });
}

export async function listBans(serverId: string, actorId: string) {
  await requirePerm(serverId, actorId, Perm.BAN_MEMBERS);
  const rows = await query<{ user_id: string; reason: string | null; created_at: Date }>(
    `SELECT user_id, reason, created_at FROM bans WHERE server_id = $1 ORDER BY created_at DESC`,
    [serverId],
  );
  const people = await Promise.all(rows.map((r) => loadPublicUser(r.user_id)));
  return rows.map((r, i) => ({ user: people[i], reason: r.reason, createdAt: r.created_at.toISOString() }));
}

export async function timeout(serverId: string, actorId: string, targetId: string, minutes: number, reason?: string) {
  const actor = await requirePerm(serverId, actorId, Perm.MODERATE_MEMBERS);
  await assertAbove(actor, serverId, targetId, actorId);
  const until = minutes > 0 ? new Date(Date.now() + minutes * 60_000) : null;
  await execute(`UPDATE server_members SET timeout_until = $3 WHERE server_id = $1 AND user_id = $2`, [serverId, targetId, until]);
  if (until) await forceDisconnectUser(targetId, serverId).catch(() => undefined);
  await audit(serverId, actorId, AuditAction.MemberTimeout, { type: 'user', id: targetId }, { minutes, reason });
  const [member] = await repo.loadMembers(serverId, [targetId]);
  await emit(Ev.MemberUpdate, member, { server: serverId });
  return member;
}

export async function setNickname(serverId: string, actorId: string, targetId: string, nickname: string | null) {
  if (actorId !== targetId) await requireManageableMember(serverId, actorId, targetId, Perm.MANAGE_SERVER);
  else await requireMember(serverId, actorId);
  await execute(`UPDATE server_members SET nickname = $3 WHERE server_id = $1 AND user_id = $2`, [serverId, targetId, nickname?.trim() || null]);
  const [member] = await repo.loadMembers(serverId, [targetId]);
  if (!member) throw Errors.notFound('Участник');
  await emit(Ev.MemberUpdate, member, { server: serverId });
  return member;
}

// ─────────────── channels ───────────────

export async function createChannel(
  serverId: string,
  userId: string,
  input: { name: string; type: 'text' | 'voice'; category?: string; topic?: string },
): Promise<ChannelDTO> {
  await requirePerm(serverId, userId, Perm.MANAGE_CHANNELS);
  const name = input.type === 'text' ? normalizeTextChannelName(input.name) : input.name.trim();
  const row = await queryOne<repo.ChannelRow>(
    `INSERT INTO channels (server_id, type, name, category, topic, position)
     VALUES ($1, $2, $3, $4, $5, coalesce((SELECT max(position) + 1 FROM channels WHERE server_id = $1 AND type = $2), 0))
     RETURNING *`,
    [serverId, input.type, name, input.category ?? (input.type === 'text' ? 'Текстовые каналы' : 'Голосовые каналы'), input.topic ?? ''],
  );
  const dto = repo.toChannel(row!);
  await audit(serverId, userId, AuditAction.ChannelCreate, { type: 'channel', id: dto.id }, { name: dto.name, type: dto.type });
  await emit(Ev.ChannelCreate, dto, { server: serverId });
  return dto;
}

export function normalizeTextChannelName(name: string): string {
  const n = name.trim().toLowerCase().replace(/\s+/g, '-').replace(/[^\p{L}\p{N}_-]/gu, '').slice(0, 64);
  if (!n) throw Errors.badRequest('Недопустимое имя канала');
  return n;
}

async function channelServer(channelId: string): Promise<repo.ChannelRow> {
  const ch = await queryOne<repo.ChannelRow>(`SELECT * FROM channels WHERE id = $1 AND server_id IS NOT NULL`, [channelId]);
  if (!ch) throw Errors.notFound('Канал');
  return ch;
}

export async function updateChannel(
  channelId: string,
  userId: string,
  patch: { name?: string; topic?: string; category?: string; position?: number; slowmodeSeconds?: number },
): Promise<ChannelDTO> {
  const ch = await channelServer(channelId);
  await requirePerm(ch.server_id!, userId, Perm.MANAGE_CHANNELS);
  const name = patch.name === undefined ? null : ch.type === 'text' ? normalizeTextChannelName(patch.name) : patch.name.trim();
  const row = await queryOne<repo.ChannelRow>(
    `UPDATE channels SET name = coalesce($2, name), topic = coalesce($3, topic), category = coalesce($4, category),
            position = coalesce($5, position), slowmode_seconds = coalesce($6, slowmode_seconds)
      WHERE id = $1 RETURNING *`,
    [channelId, name, patch.topic ?? null, patch.category ?? null, patch.position ?? null, patch.slowmodeSeconds ?? null],
  );
  const dto = repo.toChannel(row!);
  await audit(ch.server_id!, userId, AuditAction.ChannelUpdate, { type: 'channel', id: channelId }, patch);
  await emit(Ev.ChannelUpdate, dto, { server: ch.server_id! });
  return dto;
}

export async function deleteChannel(channelId: string, userId: string): Promise<void> {
  const ch = await channelServer(channelId);
  await requirePerm(ch.server_id!, userId, Perm.MANAGE_CHANNELS);
  for(const state of await statesForChannels([channelId]))await forceDisconnectUser(state.userId,ch.server_id!,channelId);
  await execute(`DELETE FROM channels WHERE id = $1`, [channelId]);
  await audit(ch.server_id!, userId, AuditAction.ChannelDelete, { type: 'channel', id: channelId }, { name: ch.name });
  await emit(Ev.ChannelDelete, { id: channelId, serverId: ch.server_id }, { server: ch.server_id! });
}

// ─────────────── roles ───────────────

function assertCanGrant(actor: MemberAccess, perms: bigint): void {
  if (perms < 0n || (perms & ~ALL_PERMISSIONS) !== 0n) throw Errors.badRequest('Недопустимые права роли');
  if (actor.isOwner || has(actor.perms, Perm.ADMINISTRATOR)) return;
  if ((perms & ~actor.perms) !== 0n) throw Errors.forbidden('Нельзя выдать права, которых нет у вас');
}

export async function createRole(serverId: string, userId: string, input: { name: string; color?: string | null; permissions?: string; hoist?: boolean }) {
  const dto = await tx(async db => {
    await lockRoles(db, serverId);
    const actor = await requirePerm(serverId, userId, Perm.MANAGE_ROLES, undefined, db);
    const perms = BigInt(input.permissions ?? DEFAULT_MEMBER_PERMS.toString());
    assertCanGrant(actor, perms);
    // Insert below the creator and shift the hierarchy in the same transaction.
    const position = actor.isOwner ? null : Math.max(1, actor.topPosition);
    const row = await queryOne<repo.RoleRow>(
      `INSERT INTO roles (server_id, name, color, permissions, position, hoist)
       VALUES ($1, $2, $3, $4, coalesce($5, (SELECT coalesce(max(position), 0) + 1 FROM roles WHERE server_id = $1)), $6) RETURNING *`,
      [serverId, input.name.trim(), input.color ?? null, perms.toString(), position, input.hoist ?? false], db,
    );
    if (position !== null) {
      await execute(`UPDATE roles SET position = position + 1 WHERE server_id = $1 AND position >= $2 AND id <> $3`, [serverId, position, row!.id], db);
    }
    return repo.toRole(row!);
  });
  await audit(serverId, userId, AuditAction.RoleCreate, { type: 'role', id: dto.id }, { name: dto.name });
  await emitRoles(serverId);
  return dto;
}

async function emitRoles(serverId: string): Promise<void> {
  const roles = (await repo.rolesOf(serverId)).map(repo.toRole);
  await emit(Ev.RoleUpdate, { serverId, roles }, { server: serverId });
}

async function lockRoles(db: Queryable, serverId: string): Promise<void> {
  // Serialize role writes without blocking FK checks of concurrent membership inserts.
  if (!(await queryOne(`SELECT id FROM servers WHERE id = $1 FOR NO KEY UPDATE`, [serverId], db))) throw Errors.notFound('Сервер');
}

async function editableRole(serverId: string, roleId: string, actor: MemberAccess, db?: Queryable): Promise<repo.RoleRow> {
  const role = await queryOne<repo.RoleRow>(`SELECT * FROM roles WHERE id = $1 AND server_id = $2`, [roleId, serverId], db);
  if (!role) throw Errors.notFound('Роль');
  if (!actor.isOwner && role.position >= actor.topPosition && !role.is_default) throw Errors.forbidden('Эта роль выше или равна вашей');
  return role;
}

export async function updateRole(
  serverId: string,
  userId: string,
  roleId: string,
  patch: { name?: string; color?: string | null; permissions?: string; hoist?: boolean },
) {
  await tx(async db => {
    await lockRoles(db, serverId);
    const actor = await requirePerm(serverId, userId, Perm.MANAGE_ROLES, undefined, db);
    const role = await editableRole(serverId, roleId, actor, db);
    if (patch.permissions !== undefined) assertCanGrant(actor, BigInt(patch.permissions));
    if (role.is_default && patch.name !== undefined && patch.name !== role.name) throw Errors.badRequest('Базовую роль нельзя переименовать');
    await execute(
      `UPDATE roles SET name = coalesce($2, name), color = CASE WHEN $3::boolean THEN $4 ELSE color END,
              permissions = coalesce($5::bigint, permissions), hoist = coalesce($6, hoist) WHERE id = $1`,
      [roleId, patch.name?.trim() ?? null, patch.color !== undefined, patch.color ?? null, patch.permissions ?? null, patch.hoist ?? null], db,
    );
  });
  await audit(serverId, userId, AuditAction.RoleUpdate, { type: 'role', id: roleId }, patch);
  if (patch.permissions !== undefined) await syncVoicePermissions(serverId);
  await emitRoles(serverId);
}

export async function deleteRole(serverId: string, userId: string, roleId: string): Promise<void> {
  const role = await tx(async db => {
    await lockRoles(db, serverId);
    const actor = await requirePerm(serverId, userId, Perm.MANAGE_ROLES, undefined, db);
    const role = await editableRole(serverId, roleId, actor, db);
    if (role.is_default) throw Errors.badRequest('Базовую роль нельзя удалить');
    await execute(`DELETE FROM roles WHERE id = $1`, [roleId], db);
    return role;
  });
  await syncVoicePermissions(serverId);
  await audit(serverId, userId, AuditAction.RoleDelete, { type: 'role', id: roleId }, { name: role.name });
  await emit(Ev.RoleDelete, { serverId, roleId }, { server: serverId });
  await emitRoles(serverId);
}

export async function setMemberRoles(serverId: string, actorId: string, targetId: string, roleIds: string[]) {
  const desired = new Set(roleIds);
  await tx(async (db) => {
    await lockRoles(db, serverId);
    await lockMembership(db, serverId, targetId);
    const actor = await requirePerm(serverId, actorId, Perm.MANAGE_ROLES, undefined, db);
    const target = await getAccess(serverId, targetId, db);
    if (!target) throw Errors.notFound('Участник');
    if (!actor.isOwner && actorId !== targetId && target.topPosition >= actor.topPosition) throw Errors.forbidden('Роль участника выше или равна вашей');
    const roles = await query<repo.RoleRow>(`SELECT * FROM roles WHERE server_id = $1 AND NOT is_default`, [serverId], db);
    const byId = new Map(roles.map(r => [r.id, r]));
    const current = new Set((await query<{role_id: string}>(`SELECT role_id FROM member_roles WHERE server_id = $1 AND user_id = $2`, [serverId, targetId], db)).map(r => r.role_id));
    for (const id of desired) if (!byId.has(id)) throw Errors.notFound('Роль');
    for (const id of new Set([...current, ...desired])) {
      if (current.has(id) === desired.has(id)) continue;
      const role = byId.get(id)!;
      if (!actor.isOwner && role.position >= actor.topPosition) throw Errors.forbidden(`Нельзя управлять ролью «${role.name}»`);
      if (desired.has(id)) assertCanGrant(actor, BigInt(role.permissions));
    }
    await execute(`DELETE FROM member_roles WHERE server_id = $1 AND user_id = $2`, [serverId, targetId], db);
    for (const id of desired) await execute(`INSERT INTO member_roles (server_id, user_id, role_id) VALUES ($1, $2, $3)`, [serverId, targetId, id], db);
  });
  await syncVoicePermissions(serverId, [targetId]);
  await audit(serverId, actorId, AuditAction.MemberRoleUpdate, { type: 'user', id: targetId }, { roleIds: [...desired] });
  const [member] = await repo.loadMembers(serverId, [targetId]);
  await emit(Ev.MemberUpdate, member, { server: serverId });
  return member;
}

// ─────────────── invites ───────────────

const INVITE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
function inviteCode(): string {
  const bytes = randomBytes(10);
  return Array.from(bytes, (b) => INVITE_ALPHABET[b % INVITE_ALPHABET.length]).join('').slice(0, 10);
}

interface InviteRow {
  code: string;
  server_id: string;
  creator_id: string | null;
  max_uses: number | null;
  uses: number;
  expires_at: Date | null;
  created_at: Date;
}

const toInvite = (r: InviteRow) => ({
  code: r.code,
  serverId: r.server_id,
  creatorId: r.creator_id,
  maxUses: r.max_uses,
  uses: r.uses,
  expiresAt: r.expires_at?.toISOString() ?? null,
  createdAt: r.created_at.toISOString(),
});

export async function createInvite(serverId: string, userId: string, input: { maxUses?: number | null; expiresInSec?: number | null }) {
  await requirePerm(serverId, userId, Perm.CREATE_INVITE);
  const row = await queryOne<InviteRow>(
    `INSERT INTO invites (code, server_id, creator_id, max_uses, expires_at)
     VALUES ($1, $2, $3, $4, CASE WHEN $5::int IS NULL THEN NULL ELSE now() + make_interval(secs => $5::int) END) RETURNING *`,
    [inviteCode(), serverId, userId, input.maxUses ?? null, input.expiresInSec ?? null],
  );
  await audit(serverId, userId, AuditAction.InviteCreate, { type: 'invite', id: row!.code }, { maxUses: input.maxUses, expiresInSec: input.expiresInSec });
  return toInvite(row!);
}

export async function listInvites(serverId: string, userId: string) {
  await requirePerm(serverId, userId, Perm.MANAGE_SERVER);
  return (await query<InviteRow>(`SELECT * FROM invites WHERE server_id = $1 ORDER BY created_at DESC`, [serverId])).map(toInvite);
}

export async function deleteInvite(code: string, userId: string): Promise<void> {
  const inv = await queryOne<InviteRow>(`SELECT * FROM invites WHERE code = $1`, [code]);
  if (!inv) throw Errors.notFound('Приглашение');
  if (inv.creator_id !== userId) await requirePerm(inv.server_id, userId, Perm.MANAGE_SERVER);
  await execute(`DELETE FROM invites WHERE code = $1`, [code]);
  await audit(inv.server_id, userId, AuditAction.InviteDelete, { type: 'invite', id: code });
}

async function validInvite(code: string): Promise<InviteRow> {
  const inv = await queryOne<InviteRow>(`SELECT * FROM invites WHERE code = $1`, [code]);
  assertInviteUsable(inv);
  return inv;
}

function assertInviteUsable(inv: InviteRow | null): asserts inv is InviteRow {
  if (!inv) throw new AppError(404, 'INVITE_INVALID', 'Приглашение недействительно');
  if (inv.expires_at && inv.expires_at.getTime() < Date.now()) throw new AppError(410, 'INVITE_EXPIRED', 'Срок действия приглашения истёк');
  if (inv.max_uses !== null && inv.uses >= inv.max_uses) throw new AppError(410, 'INVITE_EXHAUSTED', 'Приглашение больше не действует');
}

export async function previewInvite(code: string) {
  const inv = await validInvite(code);
  const server = await repo.findServer(inv.server_id);
  const inviter = inv.creator_id ? await loadPublicUser(inv.creator_id) : null;
  return { code, server: repo.toServer(server!), inviter, expiresAt: inv.expires_at?.toISOString() ?? null };
}

export async function acceptInvite(code: string, userId: string) {
  const result = await tx(async (db) => {
    // Serialize redemptions of this invite; rollback also restores its use count.
    const inv = await queryOne<InviteRow>(`SELECT * FROM invites WHERE code = $1 FOR UPDATE`, [code], db);
    if (!inv) throw new AppError(404, 'INVITE_INVALID', 'Приглашение недействительно');
    await lockMembership(db,inv.server_id,userId);
    const banned = await queryOne(`SELECT 1 FROM bans WHERE server_id = $1 AND user_id = $2`, [inv.server_id, userId], db);
    if (banned) throw Errors.forbidden('Вы заблокированы на этом сервере');
    const already = await queryOne(`SELECT 1 FROM server_members WHERE server_id = $1 AND user_id = $2`, [inv.server_id, userId], db);
    if (already) return { serverId: inv.server_id, inserted: false };
    assertInviteUsable(inv);
    const inserted = await execute(
      `INSERT INTO server_members (server_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      [inv.server_id, userId], db,
    );
    if (inserted) await execute(`UPDATE invites SET uses = uses + 1 WHERE code = $1`, [code], db);
    return { serverId: inv.server_id, inserted: inserted > 0 };
  });
  return finishJoin(result.serverId, userId, result.inserted);
}

// ─────────────── discovery ───────────────

export async function discover(search: string | undefined, limit = 30) {
  const rows = await query<repo.ServerRow>(
    `SELECT s.*, (SELECT count(*)::int FROM server_members WHERE server_id = s.id) AS member_count
       FROM servers s WHERE s.is_public AND ($1::text IS NULL OR lower(s.name) LIKE '%' || lower($1) || '%' OR lower(s.description) LIKE '%' || lower($1) || '%')
      ORDER BY member_count DESC, s.created_at DESC LIMIT $2`,
    [search?.trim() || null, limit],
  );
  return rows.map(repo.toServer);
}

export async function joinPublic(serverId: string, userId: string) {
  const s = await repo.findServer(serverId);
  if (!s?.is_public) throw Errors.notFound('Сервер');
  return join(serverId, userId);
}
