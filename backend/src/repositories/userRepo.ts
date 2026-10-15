import { query, queryOne, type Queryable, pool } from '../db/pool.js';
import { config } from '../config.js';
import { mediaUrl } from '../storage/index.js';
import { getStatuses } from '../services/presenceService.js';
import type { BadgeDTO, ChosenStatus, ProfileTheme, PublicUser, SelfUser } from '../models/dto.js';

export interface UserRow {
  id: string;
  email: string;
  email_verified_at: Date | null;
  username: string;
  display_name: string | null;
  password_hash: string;
  status: ChosenStatus;
  custom_status: string | null;
  custom_status_emoji: string | null;
  totp_secret: string | null;
  totp_enabled: boolean;
  is_platform_admin: boolean;
  created_at: Date;
  bio: string;
  avatar_key: string | null;
  banner_key: string | null;
  background_key: string | null;
  banner_color: string;
  accent_color: string;
  theme: ProfileTheme;
}

const SELECT_USER = `
  SELECT u.*, p.bio, p.avatar_key, p.banner_key, p.background_key, p.banner_color, p.accent_color, p.theme
  FROM users u JOIN profiles p ON p.user_id = u.id`;

export async function findById(id: string, db: Queryable = pool): Promise<UserRow | null> {
  return queryOne<UserRow>(`${SELECT_USER} WHERE u.id = $1`, [id], db);
}

export async function findByEmail(email: string): Promise<UserRow | null> {
  return queryOne<UserRow>(`${SELECT_USER} WHERE lower(u.email) = lower($1)`, [email]);
}

export async function findByUsername(username: string): Promise<UserRow | null> {
  return queryOne<UserRow>(`${SELECT_USER} WHERE lower(u.username) = lower($1)`, [username]);
}

export async function findManyByIds(ids: string[]): Promise<UserRow[]> {
  if (ids.length === 0) return [];
  return query<UserRow>(`${SELECT_USER} WHERE u.id = ANY($1::uuid[])`, [ids]);
}

interface BadgeRow {
  user_id: string;
  id: string;
  server_id: string | null;
  server_name: string | null;
  name: string;
  description: string;
  emoji: string | null;
  icon_key: string | null;
  color: string;
  position: number;
}

export function toBadge(r: Omit<BadgeRow, 'user_id' | 'server_name'> & { server_name?: string | null }): BadgeDTO {
  return {
    id: r.id,
    serverId: r.server_id,
    serverName: r.server_name ?? undefined,
    global: r.server_id === null,
    name: r.name,
    description: r.description,
    emoji: r.emoji,
    iconUrl: mediaUrl(r.icon_key),
    color: r.color,
    position: r.position,
  };
}

export async function badgesFor(userIds: string[]): Promise<Map<string, BadgeDTO[]>> {
  const out = new Map<string, BadgeDTO[]>();
  if (userIds.length === 0) return out;
  const rows = await query<BadgeRow>(
    `SELECT ub.user_id, b.id, b.server_id, s.name AS server_name, b.name, b.description, b.emoji, b.icon_key, b.color, b.position
       FROM user_badges ub JOIN badges b ON b.id = ub.badge_id LEFT JOIN servers s ON s.id = b.server_id
      WHERE ub.user_id = ANY($1::uuid[])
      ORDER BY (b.server_id IS NULL) DESC, b.position, b.created_at`,
    [userIds],
  );
  for (const r of rows) {
    const list = out.get(r.user_id) ?? [];
    list.push(toBadge(r));
    out.set(r.user_id, list);
  }
  return out;
}

function base(row: UserRow): Omit<PublicUser, 'status' | 'badges'> {
  return {
    id: row.id,
    username: row.username,
    displayName: row.display_name,
    avatarUrl: mediaUrl(row.avatar_key),
    bannerUrl: mediaUrl(row.banner_key),
    backgroundUrl: mediaUrl(row.background_key),
    bannerColor: row.banner_color,
    accentColor: row.accent_color,
    bio: row.bio,
    theme: row.theme,
    customStatus: row.custom_status || row.custom_status_emoji ? { text: row.custom_status, emoji: row.custom_status_emoji } : null,
    createdAt: row.created_at.toISOString(),
  };
}

/** Batch-loads public users with live presence and badges. */
export async function loadPublicUsers(ids: string[]): Promise<Map<string, PublicUser>> {
  const unique = [...new Set(ids.filter(Boolean))];
  const [rows, statuses, badges] = await Promise.all([findManyByIds(unique), getStatuses(unique), badgesFor(unique)]);
  const out = new Map<string, PublicUser>();
  for (const row of rows) {
    out.set(row.id, { ...base(row), status: statuses.get(row.id) ?? 'offline', badges: badges.get(row.id) ?? [] });
  }
  return out;
}

export async function loadPublicUser(id: string): Promise<PublicUser | null> {
  return (await loadPublicUsers([id])).get(id) ?? null;
}

export async function toSelf(row: UserRow): Promise<SelfUser> {
  const [statuses, badges] = await Promise.all([getStatuses([row.id]), badgesFor([row.id])]);
  return {
    ...base(row),
    status: statuses.get(row.id) ?? 'offline',
    badges: badges.get(row.id) ?? [],
    email: row.email,
    emailVerified: row.email_verified_at !== null,
    emailVerificationRequired: config.REQUIRE_EMAIL_VERIFICATION,
    demoMailbox: config.DEMO_MAILBOX,
    chosenStatus: row.status,
    totpEnabled: row.totp_enabled,
    isPlatformAdmin: row.is_platform_admin,
  };
}

/** Every user who should hear about presence/profile changes of `userId`: friends, DM peers, co-members. */
export async function audienceOf(userId: string): Promise<string[]> {
  const rows = await query<{ id: string }>(
    `SELECT user_b AS id FROM friendships WHERE user_a = $1
     UNION SELECT user_a FROM friendships WHERE user_b = $1
     UNION SELECT cm2.user_id FROM channel_members cm1 JOIN channel_members cm2 ON cm2.channel_id = cm1.channel_id WHERE cm1.user_id = $1
     UNION SELECT sm2.user_id FROM server_members sm1 JOIN server_members sm2 ON sm2.server_id = sm1.server_id WHERE sm1.user_id = $1`,
    [userId],
  );
  return rows.map((r) => r.id).filter((id) => id !== userId);
}
