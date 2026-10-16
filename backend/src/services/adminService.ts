import { execute, query, queryOne } from '../db/pool.js';
import { Errors } from '../http/errors.js';
import { config,platformAdminEmails } from '../config.js';
import { loadPublicUsers, toBadge } from '../repositories/userRepo.js';
import { mediaUrl } from '../storage/index.js';
import { deleteMedia, storeProcessedImage } from './mediaService.js';
import { broadcastUser } from './badgeService.js';
import { log } from '../logger.js';
import type { BadgeDTO, PublicUser } from '../models/dto.js';
import type { BadgeInput } from './badgeService.js';

/**
 * Platform administration: special (platform-wide) badges and the list of platform admins.
 * Every function re-reads users.is_platform_admin from the database, so revoking admin takes effect
 * immediately (it is not baked into the access token).
 */

export async function isPlatformAdmin(userId: string): Promise<boolean> {
  const row = await queryOne<{ is_platform_admin: boolean }>(`SELECT is_platform_admin FROM users WHERE id = $1`, [userId]);
  return !!row?.is_platform_admin;
}

export async function requirePlatformAdmin(userId: string): Promise<void> {
  if (!(await isPlatformAdmin(userId))) throw Errors.forbidden('Только для администраторов платформы');
}

/** Makes every email from PLATFORM_ADMIN_EMAILS an admin (run at startup). */
export async function syncPlatformAdmins(): Promise<void> {
  if (platformAdminEmails.length === 0 || config.DEMO_MAILBOX) return;
  const n = await execute(`UPDATE users SET is_platform_admin = true WHERE lower(email) = ANY($1::text[]) AND email_verified_via_smtp AND NOT is_platform_admin`, [platformAdminEmails]);
  if (n > 0) log.info('platform admins granted from PLATFORM_ADMIN_EMAILS', { count: n });
}

async function adminAudit(actorId: string, action: string, target: { type: string; id: string } | null, meta: Record<string, unknown> = {}): Promise<void> {
  await execute(`INSERT INTO platform_audit_log (actor_id, action, target_type, target_id, meta) VALUES ($1, $2, $3, $4, $5)`, [
    actorId,
    action,
    target?.type ?? null,
    target?.id ?? null,
    JSON.stringify(meta),
  ]);
}

// ───────────────────────────── overview ─────────────────────────────

export async function stats(actorId: string): Promise<Record<string, number>> {
  await requirePlatformAdmin(actorId);
  const row = await queryOne<Record<string, number>>(
    `SELECT (SELECT count(*)::int FROM users) AS users,
            (SELECT count(*)::int FROM servers) AS servers,
            (SELECT count(*)::int FROM messages) AS messages,
            (SELECT count(*)::int FROM badges WHERE server_id IS NULL) AS "globalBadges",
            (SELECT count(*)::int FROM users WHERE is_platform_admin) AS admins`,
  );
  return row ?? {};
}

// ───────────────────────────── special badges ─────────────────────────────

interface GlobalBadgeRow {
  id: string;
  server_id: null;
  name: string;
  description: string;
  emoji: string | null;
  icon_key: string | null;
  color: string;
  position: number;
}

async function getGlobalBadge(badgeId: string): Promise<GlobalBadgeRow> {
  const row = await queryOne<GlobalBadgeRow>(`SELECT * FROM badges WHERE id = $1 AND server_id IS NULL`, [badgeId]);
  if (!row) throw Errors.notFound('Значок');
  return row;
}

async function broadcastHolders(badgeId: string): Promise<void> {
  const holders = await query<{ user_id: string }>(`SELECT user_id FROM user_badges WHERE badge_id = $1`, [badgeId]);
  for (const h of holders) await broadcastUser(h.user_id);
}

export async function listBadges(actorId: string): Promise<(BadgeDTO & { holderCount: number })[]> {
  await requirePlatformAdmin(actorId);
  const rows = await query<GlobalBadgeRow & { holder_count: number }>(
    `SELECT b.*, (SELECT count(*)::int FROM user_badges ub WHERE ub.badge_id = b.id) AS holder_count
       FROM badges b WHERE b.server_id IS NULL ORDER BY b.position, b.created_at`,
  );
  return rows.map((r) => ({ ...toBadge(r), holderCount: r.holder_count }));
}

export async function createBadge(actorId: string, input: BadgeInput): Promise<BadgeDTO> {
  await requirePlatformAdmin(actorId);
  const count = await queryOne<{ n: number }>(`SELECT count(*)::int AS n FROM badges WHERE server_id IS NULL`);
  if ((count?.n ?? 0) >= 200) throw Errors.badRequest('Слишком много особых значков (максимум 200)');
  const row = await queryOne<GlobalBadgeRow>(
    `INSERT INTO badges (server_id, name, description, emoji, color, position, created_by)
     VALUES (NULL, $1, $2, $3, coalesce($4, '#7c6cff'), coalesce($5, (SELECT coalesce(max(position) + 1, 0) FROM badges WHERE server_id IS NULL)), $6)
     RETURNING *`,
    [input.name.trim(), input.description ?? '', input.emoji ?? null, input.color ?? null, input.position ?? null, actorId],
  );
  await adminAudit(actorId, 'badge.create', { type: 'badge', id: row!.id }, { name: row!.name });
  return toBadge(row!);
}

export async function updateBadge(actorId: string, badgeId: string, patch: Partial<BadgeInput>): Promise<BadgeDTO> {
  await requirePlatformAdmin(actorId);
  await getGlobalBadge(badgeId);
  const row = await queryOne<GlobalBadgeRow>(
    `UPDATE badges SET name = coalesce($2, name), description = coalesce($3, description),
            emoji = CASE WHEN $4 THEN $5 ELSE emoji END, color = coalesce($6, color), position = coalesce($7, position)
      WHERE id = $1 AND server_id IS NULL RETURNING *`,
    [badgeId, patch.name?.trim() ?? null, patch.description ?? null, patch.emoji !== undefined, patch.emoji ?? null, patch.color ?? null, patch.position ?? null],
  );
  await adminAudit(actorId, 'badge.update', { type: 'badge', id: badgeId }, patch);
  await broadcastHolders(badgeId);
  return toBadge(row!);
}

export async function setBadgeIcon(actorId: string, badgeId: string, data: Buffer | null): Promise<BadgeDTO> {
  await requirePlatformAdmin(actorId);
  const badge = await getGlobalBadge(badgeId);
  const key = data ? await storeProcessedImage(data, 'badge') : null;
  const row = await queryOne<GlobalBadgeRow>(`UPDATE badges SET icon_key = $2 WHERE id = $1 RETURNING *`, [badgeId, key]);
  await deleteMedia(badge.icon_key);
  await adminAudit(actorId, 'badge.icon', { type: 'badge', id: badgeId }, { icon: key ? 'changed' : 'removed' });
  await broadcastHolders(badgeId);
  return toBadge(row!);
}

export async function deleteBadge(actorId: string, badgeId: string): Promise<void> {
  await requirePlatformAdmin(actorId);
  const badge = await getGlobalBadge(badgeId);
  const holders = await query<{ user_id: string }>(`SELECT user_id FROM user_badges WHERE badge_id = $1`, [badgeId]);
  await execute(`DELETE FROM badges WHERE id = $1 AND server_id IS NULL`, [badgeId]);
  await deleteMedia(badge.icon_key);
  await adminAudit(actorId, 'badge.delete', { type: 'badge', id: badgeId }, { name: badge.name });
  for (const h of holders) await broadcastUser(h.user_id);
}

export async function badgeHolders(actorId: string, badgeId: string): Promise<PublicUser[]> {
  await requirePlatformAdmin(actorId);
  await getGlobalBadge(badgeId);
  const rows = await query<{ user_id: string }>(`SELECT user_id FROM user_badges WHERE badge_id = $1 ORDER BY created_at`, [badgeId]);
  const users = await loadPublicUsers(rows.map((r) => r.user_id));
  return rows.map((r) => users.get(r.user_id)).filter((u): u is PublicUser => !!u);
}

export async function grantBadge(actorId: string, badgeId: string, targetId: string): Promise<void> {
  await requirePlatformAdmin(actorId);
  const badge = await getGlobalBadge(badgeId);
  if (!(await queryOne(`SELECT 1 FROM users WHERE id = $1`, [targetId]))) throw Errors.notFound('Пользователь');
  await execute(`INSERT INTO user_badges (user_id, badge_id, granted_by) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`, [targetId, badgeId, actorId]);
  await adminAudit(actorId, 'badge.grant', { type: 'user', id: targetId }, { badge: badge.name });
  await broadcastUser(targetId);
}

export async function revokeBadge(actorId: string, badgeId: string, targetId: string): Promise<void> {
  await requirePlatformAdmin(actorId);
  const badge = await getGlobalBadge(badgeId);
  await execute(`DELETE FROM user_badges WHERE user_id = $1 AND badge_id = $2`, [targetId, badgeId]);
  await adminAudit(actorId, 'badge.revoke', { type: 'user', id: targetId }, { badge: badge.name });
  await broadcastUser(targetId);
}

// ───────────────────────────── users & admins ─────────────────────────────

export interface AdminUserRow {
  id: string;
  username: string;
  displayName: string | null;
  email: string;
  avatarUrl: string | null;
  isPlatformAdmin: boolean;
  /** Admin status comes from PLATFORM_ADMIN_EMAILS and can't be removed in the panel. */
  adminFromEnv: boolean;
  createdAt: string;
  globalBadgeIds: string[];
}

export async function searchUsers(actorId: string, q: string): Promise<AdminUserRow[]> {
  await requirePlatformAdmin(actorId);
  const term = q.trim().toLowerCase();
  const rows = await query<{
    id: string;
    username: string;
    display_name: string | null;
    email: string;
    avatar_key: string | null;
    is_platform_admin: boolean;
    created_at: Date;
    badge_ids: string[] | null;
  }>(
    `SELECT u.id, u.username, u.display_name, u.email, p.avatar_key, u.is_platform_admin, u.created_at,
            (SELECT array_agg(ub.badge_id) FROM user_badges ub JOIN badges b ON b.id = ub.badge_id
              WHERE ub.user_id = u.id AND b.server_id IS NULL) AS badge_ids
       FROM users u LEFT JOIN profiles p ON p.user_id = u.id
      WHERE $1 = '' OR lower(u.username) LIKE '%' || $1 || '%' OR lower(coalesce(u.display_name, '')) LIKE '%' || $1 || '%'
            OR lower(u.email) LIKE '%' || $1 || '%' OR u.id::text = $1
      ORDER BY u.is_platform_admin DESC, u.created_at DESC
      LIMIT 30`,
    [term.replace(/[%_\\]/g, (c) => `\\${c}`)],
  );
  return rows.map((r) => ({
    id: r.id,
    username: r.username,
    displayName: r.display_name,
    email: r.email,
    avatarUrl: mediaUrl(r.avatar_key),
    isPlatformAdmin: r.is_platform_admin,
    adminFromEnv: platformAdminEmails.includes(r.email.toLowerCase()),
    createdAt: r.created_at.toISOString(),
    globalBadgeIds: r.badge_ids ?? [],
  }));
}

export async function setPlatformAdmin(actorId: string, targetId: string, value: boolean): Promise<void> {
  await requirePlatformAdmin(actorId);
  const target = await queryOne<{ email: string; is_platform_admin: boolean }>(`SELECT email, is_platform_admin FROM users WHERE id = $1`, [targetId]);
  if (!target) throw Errors.notFound('Пользователь');
  if (target.is_platform_admin === value) return;
  if (!value) {
    if (platformAdminEmails.includes(target.email.toLowerCase())) {
      throw Errors.badRequest('Этот email указан в PLATFORM_ADMIN_EMAILS (.env) — уберите его оттуда, чтобы снять права');
    }
    const admins = await queryOne<{ n: number }>(`SELECT count(*)::int AS n FROM users WHERE is_platform_admin`);
    if ((admins?.n ?? 0) <= 1) throw Errors.badRequest('Нельзя снять права с последнего администратора');
  }
  await execute(`UPDATE users SET is_platform_admin = $2 WHERE id = $1`, [targetId, value]);
  await adminAudit(actorId, value ? 'admin.grant' : 'admin.revoke', { type: 'user', id: targetId });
}

// ───────────────────────────── audit ─────────────────────────────

export async function auditLog(actorId: string): Promise<{ id: string; action: string; actor: PublicUser | null; targetType: string | null; targetId: string | null; target: PublicUser | null; meta: unknown; createdAt: string }[]> {
  await requirePlatformAdmin(actorId);
  const rows = await query<{ id: string; actor_id: string | null; action: string; target_type: string | null; target_id: string | null; meta: unknown; created_at: Date }>(
    `SELECT id::text, actor_id, action, target_type, target_id, meta, created_at FROM platform_audit_log ORDER BY id DESC LIMIT 100`,
  );
  const ids = rows.flatMap((r) => [r.actor_id, r.target_type === 'user' ? r.target_id : null]).filter((x): x is string => !!x);
  const users = await loadPublicUsers(ids);
  return rows.map((r) => ({
    id: r.id,
    action: r.action,
    actor: r.actor_id ? (users.get(r.actor_id) ?? null) : null,
    targetType: r.target_type,
    targetId: r.target_id,
    target: r.target_type === 'user' && r.target_id ? (users.get(r.target_id) ?? null) : null,
    meta: r.meta,
    createdAt: r.created_at.toISOString(),
  }));
}
