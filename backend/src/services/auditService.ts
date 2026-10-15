import { execute, query, type Queryable, pool } from '../db/pool.js';
import { loadPublicUsers } from '../repositories/userRepo.js';

export const AuditAction = {
  ServerUpdate: 'server.update',
  ChannelCreate: 'channel.create',
  ChannelUpdate: 'channel.update',
  ChannelDelete: 'channel.delete',
  RoleCreate: 'role.create',
  RoleUpdate: 'role.update',
  RoleDelete: 'role.delete',
  MemberRoleUpdate: 'member.roles',
  MemberKick: 'member.kick',
  MemberBan: 'member.ban',
  MemberUnban: 'member.unban',
  MemberTimeout: 'member.timeout',
  MessageDelete: 'message.delete',
  MessagePin: 'message.pin',
  InviteCreate: 'invite.create',
  InviteDelete: 'invite.delete',
  BadgeCreate: 'badge.create',
  BadgeUpdate: 'badge.update',
  BadgeDelete: 'badge.delete',
  BadgeGrant: 'badge.grant',
  BadgeRevoke: 'badge.revoke',
  VoiceMute: 'voice.mute',
  VoiceMove: 'voice.move',
  VoiceDisconnect: 'voice.disconnect',
} as const;

export type AuditActionName = (typeof AuditAction)[keyof typeof AuditAction];

export async function audit(
  serverId: string,
  actorId: string,
  action: AuditActionName,
  target: { type: string; id: string } | null,
  data: Record<string, unknown> = {},
  db: Queryable = pool,
): Promise<void> {
  await execute(
    `INSERT INTO audit_log (server_id, actor_id, action, target_type, target_id, data) VALUES ($1, $2, $3, $4, $5, $6)`,
    [serverId, actorId, action, target?.type ?? null, target?.id ?? null, JSON.stringify(data)],
    db,
  );
}

export async function list(serverId: string, before?: string, limit = 50) {
  const rows = await query<{
    id: string;
    actor_id: string | null;
    action: string;
    target_type: string | null;
    target_id: string | null;
    data: Record<string, unknown>;
    created_at: Date;
  }>(
    `SELECT id, actor_id, action, target_type, target_id, data, created_at FROM audit_log
      WHERE server_id = $1 AND ($2::bigint IS NULL OR id < $2::bigint) ORDER BY id DESC LIMIT $3`,
    [serverId, before ?? null, Math.min(limit, 100)],
  );
  const userIds = rows.flatMap((r) => [r.actor_id, r.target_type === 'user' ? r.target_id : null]).filter((x): x is string => !!x);
  const people = await loadPublicUsers(userIds);
  return rows.map((r) => ({
    id: r.id,
    actor: r.actor_id ? (people.get(r.actor_id) ?? null) : null,
    action: r.action,
    targetType: r.target_type,
    targetId: r.target_id,
    targetUser: r.target_type === 'user' && r.target_id ? (people.get(r.target_id) ?? null) : null,
    data: r.data,
    createdAt: r.created_at.toISOString(),
  }));
}
