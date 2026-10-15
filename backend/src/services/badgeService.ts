import { execute, query, queryOne } from '../db/pool.js';
import { Errors } from '../http/errors.js';
import { Perm } from '../models/permissions.js';
import { requireMember, requirePerm, getAccess } from './permissionService.js';
import { toBadge, audienceOf, loadPublicUser } from '../repositories/userRepo.js';
import { deleteMedia, storeProcessedImage } from './mediaService.js';
import { audit, AuditAction } from './auditService.js';
import { emit } from '../websocket/bus.js';
import { Ev } from '../websocket/events.js';
import type { BadgeDTO } from '../models/dto.js';

/**
 * Badges are created by a server's staff (MANAGE_BADGES) and granted to that server's members.
 * Users can never grant badges to themselves through any other path: every mutation checks the
 * permission on the backend.
 */
interface BadgeRow {
  id: string;
  server_id: string;
  name: string;
  description: string;
  emoji: string | null;
  icon_key: string | null;
  color: string;
  position: number;
}

export async function list(serverId: string, userId: string): Promise<(BadgeDTO & { holders: string[] })[]> {
  await requireMember(serverId, userId);
  const rows = await query<BadgeRow & { holders: string[] | null }>(
    `SELECT b.*, (SELECT array_agg(user_id) FROM user_badges ub WHERE ub.badge_id = b.id) AS holders
       FROM badges b WHERE b.server_id = $1 ORDER BY b.position, b.created_at`,
    [serverId],
  );
  return rows.map((r) => ({ ...toBadge(r), holders: r.holders ?? [] }));
}

async function getBadge(serverId: string, badgeId: string): Promise<BadgeRow> {
  const row = await queryOne<BadgeRow>(`SELECT * FROM badges WHERE id = $1 AND server_id = $2`, [badgeId, serverId]);
  if (!row) throw Errors.notFound('Значок');
  return row;
}

export interface BadgeInput {
  name: string;
  description?: string;
  emoji?: string | null;
  color?: string;
  position?: number;
}

export async function create(serverId: string, userId: string, input: BadgeInput): Promise<BadgeDTO> {
  await requirePerm(serverId, userId, Perm.MANAGE_BADGES, 'Нет права управлять значками');
  const count = await queryOne<{ n: number }>(`SELECT count(*)::int AS n FROM badges WHERE server_id = $1`, [serverId]);
  if ((count?.n ?? 0) >= 100) throw Errors.badRequest('Достигнут лимит значков (100)');
  const row = await queryOne<BadgeRow>(
    `INSERT INTO badges (server_id, name, description, emoji, color, position, created_by)
     VALUES ($1, $2, $3, $4, coalesce($5, '#7c6cff'), coalesce($6, (SELECT coalesce(max(position) + 1, 0) FROM badges WHERE server_id = $1)), $7)
     RETURNING *`,
    [serverId, input.name.trim(), input.description ?? '', input.emoji ?? null, input.color ?? null, input.position ?? null, userId],
  );
  await audit(serverId, userId, AuditAction.BadgeCreate, { type: 'badge', id: row!.id }, { name: row!.name });
  return toBadge(row!);
}

async function broadcastHolders(badgeId: string): Promise<void> {
  const holders = await query<{ user_id: string }>(`SELECT user_id FROM user_badges WHERE badge_id = $1`, [badgeId]);
  for (const h of holders) await broadcastUser(h.user_id);
}

export async function broadcastUser(userId: string): Promise<void> {
  const user = await loadPublicUser(userId);
  if (!user) return;
  await emit(Ev.UserUpdate, user, { users: [...(await audienceOf(userId)), userId] });
}

export async function update(serverId: string, userId: string, badgeId: string, patch: Partial<BadgeInput>): Promise<BadgeDTO> {
  await requirePerm(serverId, userId, Perm.MANAGE_BADGES, 'Нет права управлять значками');
  await getBadge(serverId, badgeId);
  const row = await queryOne<BadgeRow>(
    `UPDATE badges SET name = coalesce($3, name), description = coalesce($4, description),
            emoji = CASE WHEN $5::boolean THEN $6 ELSE emoji END, color = coalesce($7, color), position = coalesce($8, position)
      WHERE id = $1 AND server_id = $2 RETURNING *`,
    [badgeId, serverId, patch.name?.trim() ?? null, patch.description ?? null, patch.emoji !== undefined, patch.emoji ?? null, patch.color ?? null, patch.position ?? null],
  );
  await audit(serverId, userId, AuditAction.BadgeUpdate, { type: 'badge', id: badgeId }, patch);
  await broadcastHolders(badgeId);
  return toBadge(row!);
}

export async function setIcon(serverId: string, userId: string, badgeId: string, data: Buffer | null): Promise<BadgeDTO> {
  await requirePerm(serverId, userId, Perm.MANAGE_BADGES, 'Нет права управлять значками');
  const badge = await getBadge(serverId, badgeId);
  const key = data ? await storeProcessedImage(data, 'badge') : null;
  const row = await queryOne<BadgeRow>(`UPDATE badges SET icon_key = $2 WHERE id = $1 RETURNING *`, [badgeId, key]);
  await deleteMedia(badge.icon_key);
  await audit(serverId, userId, AuditAction.BadgeUpdate, { type: 'badge', id: badgeId }, { icon: key ? 'changed' : 'removed' });
  await broadcastHolders(badgeId);
  return toBadge(row!);
}

export async function remove(serverId: string, userId: string, badgeId: string): Promise<void> {
  await requirePerm(serverId, userId, Perm.MANAGE_BADGES, 'Нет права управлять значками');
  const badge = await getBadge(serverId, badgeId);
  const holders = await query<{ user_id: string }>(`SELECT user_id FROM user_badges WHERE badge_id = $1`, [badgeId]);
  await execute(`DELETE FROM badges WHERE id = $1`, [badgeId]);
  await deleteMedia(badge.icon_key);
  await audit(serverId, userId, AuditAction.BadgeDelete, { type: 'badge', id: badgeId }, { name: badge.name });
  for (const h of holders) await broadcastUser(h.user_id);
}

export async function grant(serverId: string, actorId: string, badgeId: string, targetId: string): Promise<void> {
  await requirePerm(serverId, actorId, Perm.MANAGE_BADGES, 'Нет права выдавать значки');
  const badge = await getBadge(serverId, badgeId);
  if (!(await getAccess(serverId, targetId))) throw Errors.badRequest('Значок можно выдать только участнику сервера');
  await execute(`INSERT INTO user_badges (user_id, badge_id, granted_by) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`, [targetId, badgeId, actorId]);
  await audit(serverId, actorId, AuditAction.BadgeGrant, { type: 'user', id: targetId }, { badge: badge.name });
  await broadcastUser(targetId);
  await emit(Ev.BadgeUpdate, { serverId }, { server: serverId });
}

export async function revoke(serverId: string, actorId: string, badgeId: string, targetId: string): Promise<void> {
  await requirePerm(serverId, actorId, Perm.MANAGE_BADGES, 'Нет права снимать значки');
  const badge = await getBadge(serverId, badgeId);
  await execute(`DELETE FROM user_badges WHERE user_id = $1 AND badge_id = $2`, [targetId, badgeId]);
  await audit(serverId, actorId, AuditAction.BadgeRevoke, { type: 'user', id: targetId }, { badge: badge.name });
  await broadcastUser(targetId);
  await emit(Ev.BadgeUpdate, { serverId }, { server: serverId });
}
