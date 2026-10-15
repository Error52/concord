import { query, queryOne } from '../db/pool.js';
import { Errors } from '../http/errors.js';
import { hydrate, MESSAGE_COLUMNS, type MessageRow } from '../repositories/messageRepo.js';
import { loadPublicUsers } from '../repositories/userRepo.js';
import { toServer, type ServerRow } from '../repositories/serverRepo.js';
import { requireChannel, requireMember } from './permissionService.js';

export type HasFilter = 'link' | 'image' | 'file' | 'gif';

export interface MessageSearch {
  q?: string;
  serverId?: string;
  channelId?: string;
  authorId?: string;
  before?: string; // ISO date
  after?: string;
  has?: HasFilter[];
  offset?: number;
  limit?: number;
}

/**
 * Builds a prefix tsquery ("hel wor" → "hel:* & wor:*") from user input. Only letters and digits survive,
 * so the query cannot inject tsquery operators.
 */
export function toPrefixTsQuery(q: string): string | null {
  const words = q
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean)
    .slice(0, 8);
  return words.length ? words.map((w) => `${w}:*`).join(' & ') : null;
}

const HAS_COLUMN: Record<HasFilter, string> = { link: 'has_link', image: 'has_image', file: 'has_file', gif: 'has_gif' };

export async function searchMessages(userId: string, s: MessageSearch) {
  if (s.channelId) await requireChannel(s.channelId, userId);
  else if (s.serverId) await requireMember(s.serverId, userId);

  const where: string[] = [];
  const params: unknown[] = [userId];
  const p = (v: unknown): string => {
    params.push(v);
    return `$${params.length}`;
  };

  // Visibility: servers the user belongs to, or DMs the user participates in.
  where.push(`(
    (c.server_id IS NOT NULL AND EXISTS (SELECT 1 FROM server_members sm WHERE sm.server_id = c.server_id AND sm.user_id = $1))
    OR (c.server_id IS NULL AND EXISTS (SELECT 1 FROM channel_members cm WHERE cm.channel_id = c.id AND cm.user_id = $1)))`);
  where.push(`m.kind = 'default'`);
  const tsq = s.q ? toPrefixTsQuery(s.q) : null;
  if (tsq) where.push(`m.search @@ to_tsquery('simple', ${p(tsq)})`);
  if (s.channelId) where.push(`m.channel_id = ${p(s.channelId)}`);
  else if (s.serverId) where.push(`c.server_id = ${p(s.serverId)}`);
  if (s.authorId) where.push(`m.author_id = ${p(s.authorId)}`);
  if (s.before) where.push(`m.created_at < ${p(new Date(s.before))}`);
  if (s.after) where.push(`m.created_at >= ${p(new Date(s.after))}`);
  for (const h of s.has ?? []) where.push(`m.${HAS_COLUMN[h]}`);

  if (!tsq && !s.authorId && !(s.has?.length) && !s.before && !s.after) throw Errors.badRequest('Введите запрос или выберите фильтр');

  const limit = Math.min(Math.max(s.limit ?? 25, 1), 50);
  const offset = Math.max(s.offset ?? 0, 0);
  const sqlWhere = where.join(' AND ');
  const [rows, total] = await Promise.all([
    query<MessageRow & { channel_name: string }>(
      `SELECT ${MESSAGE_COLUMNS}, c.name AS channel_name FROM messages m JOIN channels c ON c.id = m.channel_id
        WHERE ${sqlWhere} ORDER BY m.id DESC LIMIT ${limit} OFFSET ${offset}`,
      params,
    ),
    queryOne<{ n: number }>(
      `SELECT count(*)::int AS n FROM (SELECT 1 FROM messages m JOIN channels c ON c.id = m.channel_id WHERE ${sqlWhere} LIMIT 1000) t`,
      params,
    ),
  ]);
  const messages = await hydrate(rows, userId);
  const names = new Map(rows.map((r) => [r.id, r.channel_name]));
  return {
    total: total?.n ?? 0,
    offset,
    limit,
    results: messages.map((m) => ({ ...m, channelName: names.get(m.id) ?? '' })),
  };
}

/** Global quick search: people, servers you're in, channels you can see. */
export async function quickSearch(userId: string, q: string) {
  const term = q.trim().toLowerCase();
  if (!term) return { users: [], servers: [], channels: [] };
  const like = `%${term.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
  const [userRows, serverRows, channelRows] = await Promise.all([
    query<{ id: string }>(
      `SELECT u.id FROM users u
        WHERE (lower(u.username) LIKE $2 OR lower(coalesce(u.display_name, '')) LIKE $2)
          AND NOT EXISTS (SELECT 1 FROM blocks b WHERE b.blocker_id = u.id AND b.blocked_id = $1)
        ORDER BY (lower(u.username) = $3) DESC, length(u.username) LIMIT 10`,
      [userId, like, term],
    ),
    query<ServerRow>(
      `SELECT s.* FROM servers s WHERE lower(s.name) LIKE $2
          AND (s.is_public OR EXISTS (SELECT 1 FROM server_members sm WHERE sm.server_id = s.id AND sm.user_id = $1))
        ORDER BY s.name LIMIT 10`,
      [userId, like],
    ),
    query<{ id: string; name: string; type: string; server_id: string; server_name: string }>(
      `SELECT c.id, c.name, c.type, c.server_id, s.name AS server_name FROM channels c JOIN servers s ON s.id = c.server_id
        JOIN server_members sm ON sm.server_id = c.server_id AND sm.user_id = $1
        WHERE lower(c.name) LIKE $2 ORDER BY c.name LIMIT 10`,
      [userId, like],
    ),
  ]);
  const people = await loadPublicUsers(userRows.map((r) => r.id));
  return {
    users: userRows.map((r) => people.get(r.id)).filter(Boolean),
    servers: serverRows.map(toServer),
    channels: channelRows.map((c) => ({ id: c.id, name: c.name, type: c.type, serverId: c.server_id, serverName: c.server_name })),
  };
}
