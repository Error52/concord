import { execute, query, queryOne, tx } from '../db/pool.js';
import { Errors } from '../http/errors.js';
import { loadPublicUsers } from '../repositories/userRepo.js';
import { emit } from '../websocket/bus.js';
import { Ev } from '../websocket/events.js';
import { statesForChannels } from './voiceService.js';
import type { PublicUser } from '../models/dto.js';

export interface DmDTO {
  id: string;
  type: 'dm';
  recipients: PublicUser[];
  lastMessageId: string | null;
}

async function toDtos(rows: { id: string; last_message_id: string | null; peers: string[] }[], viewerId: string): Promise<DmDTO[]> {
  const users = await loadPublicUsers(rows.flatMap((r) => r.peers));
  return rows.map((r) => ({
    id: r.id,
    type: 'dm' as const,
    recipients: r.peers.filter((p) => p !== viewerId).map((p) => users.get(p)).filter((u): u is PublicUser => !!u),
    lastMessageId: r.last_message_id,
  }));
}

export async function list(userId: string): Promise<DmDTO[]> {
  const rows = await query<{ id: string; last_message_id: string | null; peers: string[] }>(
    `SELECT c.id, c.last_message_id, (SELECT array_agg(user_id) FROM channel_members WHERE channel_id = c.id) AS peers
       FROM channels c JOIN channel_members me ON me.channel_id = c.id AND me.user_id = $1
      WHERE c.type = 'dm' AND NOT me.hidden
      ORDER BY c.last_message_id DESC NULLS LAST, c.created_at DESC`,
    [userId],
  );
  return toDtos(rows, userId);
}

export async function get(channelId: string, userId: string): Promise<DmDTO> {
  const row = await queryOne<{ id: string; last_message_id: string | null; peers: string[] }>(
    `SELECT c.id, c.last_message_id, (SELECT array_agg(user_id) FROM channel_members WHERE channel_id = c.id) AS peers
       FROM channels c JOIN channel_members me ON me.channel_id = c.id AND me.user_id = $2 WHERE c.id = $1 AND c.type = 'dm'`,
    [channelId, userId],
  );
  if (!row) throw Errors.notFound('Диалог');
  return (await toDtos([row], userId))[0]!;
}

/** Opens (or re-opens) the 1:1 conversation between two users. */
export async function open(userId: string, recipientId: string): Promise<DmDTO> {
  if (userId === recipientId) throw Errors.badRequest('Нельзя написать самому себе');
  const exists = await queryOne(`SELECT 1 FROM users WHERE id = $1`, [recipientId]);
  if (!exists) throw Errors.notFound('Пользователь');
  const blockedByThem = await queryOne(`SELECT 1 FROM blocks WHERE blocker_id = $1 AND blocked_id = $2`, [recipientId, userId]);
  if (blockedByThem) throw Errors.forbidden('Этот пользователь ограничил личные сообщения');
  const key = [userId, recipientId].sort().join(':');
  const id = await tx(async (db) => {
    const existing = await queryOne<{ id: string }>(`SELECT id FROM channels WHERE dm_key = $1`, [key], db);
    if (existing) {
      await execute(`UPDATE channel_members SET hidden = false WHERE channel_id = $1 AND user_id = $2`, [existing.id, userId], db);
      return existing.id;
    }
    const ch = await queryOne<{ id: string }>(
      `INSERT INTO channels (type, dm_key) VALUES ('dm', $1) ON CONFLICT (dm_key) DO UPDATE SET dm_key = EXCLUDED.dm_key RETURNING id`,
      [key],
      db,
    );
    await execute(
      `INSERT INTO channel_members (channel_id, user_id) VALUES ($1, $2), ($1, $3) ON CONFLICT DO NOTHING`,
      [ch!.id, userId, recipientId],
      db,
    );
    return ch!.id;
  });
  const dto = await get(id, userId);
  await emit(Ev.DmCreate, dto, { users: [userId] });
  return dto;
}

export async function hide(channelId: string, userId: string): Promise<void> {
  const n = await execute(`UPDATE channel_members SET hidden = true WHERE channel_id = $1 AND user_id = $2`, [channelId, userId]);
  if (n === 0) throw Errors.notFound('Диалог');
}

export async function voiceStates(userId: string) {
  const ids = await query<{ id: string }>(
    `SELECT c.id FROM channels c JOIN channel_members cm ON cm.channel_id = c.id WHERE cm.user_id = $1 AND c.type = 'dm'`,
    [userId],
  );
  return statesForChannels(ids.map((r) => r.id));
}
