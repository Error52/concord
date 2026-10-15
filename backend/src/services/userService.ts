import { execute, query, queryOne } from '../db/pool.js';
import { Errors } from '../http/errors.js';
import * as users from '../repositories/userRepo.js';
import { toServer, type ServerRow } from '../repositories/serverRepo.js';
import { deleteMedia, storeProcessedImage, type MediaKind } from './mediaService.js';
import { emit } from '../websocket/bus.js';
import { Ev } from '../websocket/events.js';
import { recompute } from './presenceService.js';
import { isReadableGradient, HEX_RE } from '../utils/color.js';
import type { ChosenStatus, ProfileTheme, SelfUser } from '../models/dto.js';

export async function me(userId: string): Promise<SelfUser> {
  const row = await users.findById(userId);
  if (!row) throw Errors.unauthorized();
  return users.toSelf(row);
}

async function broadcastProfile(userId: string): Promise<SelfUser> {
  const self = await me(userId);
  const { email: _e, chosenStatus: _c, totpEnabled: _t, isPlatformAdmin: _a, ...pub } = self;
  const audience = await users.audienceOf(userId);
  await emit(Ev.UserUpdate, pub, { users: audience });
  await emit(Ev.UserUpdate, self, { users: [userId] });
  return self;
}

export const PRESET_THEMES: Record<string, { primary: string; secondary: string }> = {
  default: { primary: '#1e1f2e', secondary: '#2b2d42' },
  dark: { primary: '#0d0d12', secondary: '#1a1a24' },
  purple: { primary: '#2a1650', secondary: '#4b2a8a' },
  blue: { primary: '#0f2347', secondary: '#1d4a8f' },
  sunset: { primary: '#5a1f3d', secondary: '#8a3b1f' },
  cyber: { primary: '#0b2a2f', secondary: '#3a0f4f' },
  neon: { primary: '#140a2e', secondary: '#063a3a' },
  minimal: { primary: '#202225', secondary: '#202225' },
};

/** Validates colors and rejects combinations where neither light nor dark text would be readable. */
export function normalizeTheme(theme: ProfileTheme): ProfileTheme {
  const preset = theme.preset in PRESET_THEMES || theme.preset === 'custom' ? theme.preset : 'default';
  const fallback = PRESET_THEMES[preset] ?? PRESET_THEMES.default!;
  const primary = theme.primary ?? fallback.primary;
  const secondary = theme.secondary ?? fallback.secondary;
  if (!HEX_RE.test(primary) || !HEX_RE.test(secondary)) throw Errors.badRequest('Цвета темы должны быть в формате #RRGGBB');
  if (!isReadableGradient(primary, secondary)) {
    throw Errors.badRequest('Эти цвета делают текст профиля нечитаемым — выберите более тёмные или более светлые оттенки', {
      field: 'theme',
    });
  }
  return {
    preset,
    primary,
    secondary,
    background: theme.background ?? 'gradient',
    glow: theme.glow ?? false,
    cardStyle: theme.cardStyle ?? 'default',
  };
}

export interface ProfilePatch {
  username?: string;
  displayName?: string | null;
  bio?: string;
  bannerColor?: string;
  accentColor?: string;
  theme?: ProfileTheme;
  customStatus?: { text: string | null; emoji: string | null } | null;
}

export async function updateProfile(userId: string, patch: ProfilePatch): Promise<SelfUser> {
  if (patch.username) {
    const other = await users.findByUsername(patch.username);
    if (other && other.id !== userId) throw Errors.conflict('USERNAME_TAKEN', 'Это имя пользователя уже занято');
  }
  const theme = patch.theme ? normalizeTheme(patch.theme) : null;
  await execute(
    `UPDATE users SET username = coalesce($2, username),
            display_name = CASE WHEN $3::boolean THEN $4 ELSE display_name END,
            custom_status = CASE WHEN $5::boolean THEN $6 ELSE custom_status END,
            custom_status_emoji = CASE WHEN $5::boolean THEN $7 ELSE custom_status_emoji END,
            updated_at = now()
      WHERE id = $1`,
    [
      userId,
      patch.username ?? null,
      patch.displayName !== undefined,
      patch.displayName?.trim() || null,
      patch.customStatus !== undefined,
      patch.customStatus?.text?.trim() || null,
      patch.customStatus?.emoji || null,
    ],
  );
  await execute(
    `UPDATE profiles SET bio = coalesce($2, bio), banner_color = coalesce($3, banner_color), accent_color = coalesce($4, accent_color),
            theme = coalesce($5::jsonb, theme) WHERE user_id = $1`,
    [userId, patch.bio ?? null, patch.bannerColor ?? null, patch.accentColor ?? null, theme ? JSON.stringify(theme) : null],
  );
  return broadcastProfile(userId);
}

const IMAGE_COLUMN: Record<'avatar' | 'banner' | 'background', { column: string; kind: MediaKind }> = {
  avatar: { column: 'avatar_key', kind: 'avatar' },
  banner: { column: 'banner_key', kind: 'banner' },
  background: { column: 'background_key', kind: 'background' },
};

export async function setImage(userId: string, field: 'avatar' | 'banner' | 'background', data: Buffer | null): Promise<SelfUser> {
  const { column, kind } = IMAGE_COLUMN[field];
  const old = await queryOne<{ key: string | null }>(`SELECT ${column} AS key FROM profiles WHERE user_id = $1`, [userId]);
  const key = data ? await storeProcessedImage(data, kind) : null;
  await execute(`UPDATE profiles SET ${column} = $2 WHERE user_id = $1`, [userId, key]);
  await deleteMedia(old?.key);
  return broadcastProfile(userId);
}

export async function setStatus(userId: string, status: ChosenStatus): Promise<SelfUser> {
  await execute(`UPDATE users SET status = $2, updated_at = now() WHERE id = $1`, [userId, status]);
  const changed = await recompute(userId, status);
  if (changed) {
    const audience = await users.audienceOf(userId);
    await emit(Ev.PresenceUpdate, { userId, status: changed }, { users: [...audience, userId] });
  }
  return me(userId);
}

/** Full profile as seen by `viewerId`: adds mutual servers and mutual friends. */
export async function profileFor(targetId: string, viewerId: string) {
  const user = await users.loadPublicUser(targetId);
  if (!user) throw Errors.notFound('Пользователь');
  const [mutualServers, mutualFriends, relation] = await Promise.all([
    query<ServerRow>(
      `SELECT s.* FROM servers s
        JOIN server_members a ON a.server_id = s.id AND a.user_id = $1
        JOIN server_members b ON b.server_id = s.id AND b.user_id = $2 ORDER BY s.name`,
      [targetId, viewerId],
    ),
    query<{ id: string }>(
      `WITH f1 AS (SELECT CASE WHEN user_a = $1 THEN user_b ELSE user_a END AS id FROM friendships WHERE user_a = $1 OR user_b = $1),
            f2 AS (SELECT CASE WHEN user_a = $2 THEN user_b ELSE user_a END AS id FROM friendships WHERE user_a = $2 OR user_b = $2)
       SELECT id FROM f1 INTERSECT SELECT id FROM f2`,
      [targetId, viewerId],
    ),
    queryOne<{ rel: string }>(
      `SELECT CASE
          WHEN EXISTS (SELECT 1 FROM blocks WHERE blocker_id = $2 AND blocked_id = $1) THEN 'blocked'
          WHEN EXISTS (SELECT 1 FROM friendships WHERE (user_a = $1 AND user_b = $2) OR (user_a = $2 AND user_b = $1)) THEN 'friend'
          WHEN EXISTS (SELECT 1 FROM friend_requests WHERE from_id = $2 AND to_id = $1) THEN 'outgoing'
          WHEN EXISTS (SELECT 1 FROM friend_requests WHERE from_id = $1 AND to_id = $2) THEN 'incoming'
          ELSE 'none' END AS rel`,
      [targetId, viewerId],
    ),
  ]);
  const friends = await users.loadPublicUsers(mutualFriends.map((f) => f.id));
  return {
    user,
    mutualServers: mutualServers.map(toServer),
    mutualFriends: [...friends.values()],
    relationship: targetId === viewerId ? 'self' : (relation?.rel ?? 'none'),
  };
}
