import { query, queryOne, type Queryable, pool } from '../db/pool.js';
import { mediaUrl } from '../storage/index.js';
import { loadPublicUsers } from './userRepo.js';
import type { ChannelDTO, MemberDTO, RoleDTO, ServerDTO } from '../models/dto.js';

export interface ServerRow {
  id: string;
  name: string;
  description: string;
  icon_key: string | null;
  banner_key: string | null;
  owner_id: string;
  is_public: boolean;
  created_at: Date;
  member_count?: number;
}

export interface ChannelRow {
  id: string;
  server_id: string | null;
  type: 'text' | 'voice' | 'dm';
  name: string;
  topic: string;
  category: string;
  position: number;
  slowmode_seconds: number;
  last_message_id: string | null;
}

export interface RoleRow {
  id: string;
  server_id: string;
  name: string;
  color: string | null;
  permissions: string;
  position: number;
  is_default: boolean;
  hoist: boolean;
}

export const toServer = (r: ServerRow): ServerDTO => ({
  id: r.id,
  name: r.name,
  description: r.description,
  iconUrl: mediaUrl(r.icon_key),
  bannerUrl: mediaUrl(r.banner_key),
  ownerId: r.owner_id,
  isPublic: r.is_public,
  createdAt: r.created_at.toISOString(),
  memberCount: r.member_count,
});

export const toChannel = (r: ChannelRow): ChannelDTO => ({
  id: r.id,
  serverId: r.server_id,
  type: r.type,
  name: r.name,
  topic: r.topic,
  category: r.category,
  position: r.position,
  slowmodeSeconds: r.slowmode_seconds,
  lastMessageId: r.last_message_id,
});

export const toRole = (r: RoleRow): RoleDTO => ({
  id: r.id,
  serverId: r.server_id,
  name: r.name,
  color: r.color,
  permissions: String(r.permissions),
  position: r.position,
  isDefault: r.is_default,
  hoist: r.hoist,
});

export async function findServer(id: string, db: Queryable = pool): Promise<ServerRow | null> {
  return queryOne<ServerRow>(
    `SELECT s.*, (SELECT count(*)::int FROM server_members WHERE server_id = s.id) AS member_count FROM servers s WHERE s.id = $1`,
    [id],
    db,
  );
}

export async function serversOfUser(userId: string): Promise<ServerRow[]> {
  return query<ServerRow>(
    `SELECT s.*, (SELECT count(*)::int FROM server_members WHERE server_id = s.id) AS member_count
       FROM servers s JOIN server_members sm ON sm.server_id = s.id
      WHERE sm.user_id = $1 ORDER BY sm.joined_at`,
    [userId],
  );
}

export async function channelsOf(serverId: string): Promise<ChannelRow[]> {
  return query<ChannelRow>(`SELECT * FROM channels WHERE server_id = $1 ORDER BY type DESC, position, created_at`, [serverId]);
}

export async function rolesOf(serverId: string): Promise<RoleRow[]> {
  return query<RoleRow>(`SELECT * FROM roles WHERE server_id = $1 ORDER BY position DESC`, [serverId]);
}

export async function memberIds(serverId: string): Promise<string[]> {
  return (await query<{ user_id: string }>(`SELECT user_id FROM server_members WHERE server_id = $1`, [serverId])).map((r) => r.user_id);
}

export async function loadMembers(serverId: string, userIds?: string[]): Promise<MemberDTO[]> {
  const rows = await query<{ user_id: string; nickname: string | null; joined_at: Date; timeout_until: Date | null; role_ids: string[] | null }>(
    `SELECT sm.user_id, sm.nickname, sm.joined_at, sm.timeout_until,
            (SELECT array_agg(role_id) FROM member_roles mr WHERE mr.server_id = sm.server_id AND mr.user_id = sm.user_id) AS role_ids
       FROM server_members sm
      WHERE sm.server_id = $1 AND ($2::uuid[] IS NULL OR sm.user_id = ANY($2::uuid[]))
      ORDER BY sm.joined_at`,
    [serverId, userIds ?? null],
  );
  const users = await loadPublicUsers(rows.map((r) => r.user_id));
  return rows
    .filter((r) => users.has(r.user_id))
    .map((r) => ({
      serverId,
      user: users.get(r.user_id)!,
      nickname: r.nickname,
      roleIds: r.role_ids ?? [],
      joinedAt: r.joined_at.toISOString(),
      timeoutUntil: r.timeout_until && r.timeout_until.getTime() > Date.now() ? r.timeout_until.toISOString() : null,
    }));
}
