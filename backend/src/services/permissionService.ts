import { queryOne } from '../db/pool.js';
import { Errors } from '../http/errors.js';
import { ALL_PERMISSIONS, Perm, has } from '../models/permissions.js';

export interface MemberAccess {
  serverId: string;
  isOwner: boolean;
  perms: bigint;
  /** Highest role position; owners get +Infinity. Used for role hierarchy checks. */
  topPosition: number;
  timedOutUntil: Date | null;
}

const TIMEOUT_DENY = Perm.SEND_MESSAGES | Perm.ADD_REACTIONS | Perm.CONNECT | Perm.SPEAK | Perm.VIDEO | Perm.ATTACH_FILES;

/** Returns null if the user is not a member of the server. */
export async function getAccess(serverId: string, userId: string): Promise<MemberAccess | null> {
  const row = await queryOne<{ owner_id: string; timeout_until: Date | null; perms: string | null; top: number | null }>(
    `SELECT s.owner_id, sm.timeout_until,
            (SELECT bit_or(r.permissions) FROM roles r
              WHERE r.server_id = s.id AND (r.is_default OR r.id IN (SELECT role_id FROM member_roles mr WHERE mr.server_id = s.id AND mr.user_id = sm.user_id)))::text AS perms,
            (SELECT max(r.position) FROM roles r JOIN member_roles mr ON mr.role_id = r.id WHERE mr.server_id = s.id AND mr.user_id = sm.user_id) AS top
       FROM servers s JOIN server_members sm ON sm.server_id = s.id AND sm.user_id = $2
      WHERE s.id = $1`,
    [serverId, userId],
  );
  if (!row) return null;
  const isOwner = row.owner_id === userId;
  let perms = isOwner ? ALL_PERMISSIONS : BigInt(row.perms ?? '0');
  const timedOut = row.timeout_until && row.timeout_until.getTime() > Date.now() ? row.timeout_until : null;
  if (timedOut && !isOwner && !has(perms, Perm.ADMINISTRATOR)) perms &= ~TIMEOUT_DENY;
  return {
    serverId,
    isOwner,
    perms,
    topPosition: isOwner ? Number.POSITIVE_INFINITY : (row.top ?? 0),
    timedOutUntil: timedOut,
  };
}

export async function requireMember(serverId: string, userId: string): Promise<MemberAccess> {
  const access = await getAccess(serverId, userId);
  // 404 instead of 403: don't confirm the existence of servers the user can't see.
  if (!access) throw Errors.notFound('Сервер');
  return access;
}

export async function requirePerm(serverId: string, userId: string, flag: bigint, message?: string): Promise<MemberAccess> {
  const access = await requireMember(serverId, userId);
  if (!has(access.perms, flag)) {
    if (access.timedOutUntil && (flag & TIMEOUT_DENY) !== 0n) throw Errors.forbidden('Вы временно ограничены (тайм-аут)');
    throw Errors.forbidden(message);
  }
  return access;
}

export interface ChannelAccess {
  channel: {
    id: string;
    server_id: string | null;
    type: 'text' | 'voice' | 'dm';
    name: string;
    slowmode_seconds: number;
  };
  access: MemberAccess | null; // null for DMs
  dmPeers: string[];
}

/** Resolves a channel the user may see: server membership for server channels, participation for DMs. */
export async function requireChannel(channelId: string, userId: string): Promise<ChannelAccess> {
  if (!/^[0-9a-f-]{36}$/i.test(channelId)) throw Errors.notFound('Канал');
  const channel = await queryOne<ChannelAccess['channel'] & { peers: string[] | null; is_member: boolean }>(
    `SELECT c.id, c.server_id, c.type, c.name, c.slowmode_seconds,
            (SELECT array_agg(user_id) FROM channel_members WHERE channel_id = c.id) AS peers,
            EXISTS (SELECT 1 FROM channel_members WHERE channel_id = c.id AND user_id = $2) AS is_member
       FROM channels c WHERE c.id = $1`,
    [channelId, userId],
  );
  if (!channel) throw Errors.notFound('Канал');
  if (channel.type === 'dm') {
    if (!channel.is_member) throw Errors.notFound('Канал');
    return { channel, access: null, dmPeers: channel.peers ?? [] };
  }
  const access = await getAccess(channel.server_id!, userId);
  if (!access) throw Errors.notFound('Канал');
  return { channel, access, dmPeers: [] };
}

export function assertPerm(ca: ChannelAccess, flag: bigint, message?: string): void {
  if (ca.access && !has(ca.access.perms, flag)) {
    if (ca.access.timedOutUntil) throw Errors.forbidden('Вы временно ограничены (тайм-аут)');
    throw Errors.forbidden(message);
  }
}

export function canManage(ca: ChannelAccess, flag: bigint): boolean {
  return ca.access !== null && has(ca.access.perms, flag);
}
