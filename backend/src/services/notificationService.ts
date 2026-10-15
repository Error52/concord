import { execute, query, queryOne } from '../db/pool.js';
import { emit } from '../websocket/bus.js';
import { Ev } from '../websocket/events.js';

export type NotificationType = 'mention' | 'everyone' | 'dm' | 'friend_request' | 'friend_accept' | 'call' | 'server';

export interface NotificationDTO {
  id: string;
  type: NotificationType;
  data: Record<string, unknown>;
  read: boolean;
  createdAt: string;
}

interface Row {
  id: string;
  type: NotificationType;
  data: Record<string, unknown>;
  read_at: Date | null;
  created_at: Date;
}

const toDto = (r: Row): NotificationDTO => ({
  id: r.id,
  type: r.type,
  data: r.data,
  read: r.read_at !== null,
  createdAt: r.created_at.toISOString(),
});

export async function notify(userIds: string[], type: NotificationType, data: Record<string, unknown>): Promise<void> {
  for (const userId of new Set(userIds)) {
    const row = await queryOne<Row>(
      `INSERT INTO notifications (user_id, type, data) VALUES ($1, $2, $3) RETURNING id, type, data, read_at, created_at`,
      [userId, type, JSON.stringify(data)],
    );
    await emit(Ev.NotificationNew, toDto(row!), { users: [userId] });
  }
}

export async function list(userId: string, limit = 50) {
  const rows = await query<Row>(
    `SELECT id, type, data, read_at, created_at FROM notifications WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2`,
    [userId, Math.min(limit, 100)],
  );
  const unread = await queryOne<{ n: number }>(`SELECT count(*)::int AS n FROM notifications WHERE user_id = $1 AND read_at IS NULL`, [userId]);
  return { items: rows.map(toDto), unread: unread?.n ?? 0 };
}

export async function markRead(userId: string, ids: string[] | 'all'): Promise<void> {
  if (ids === 'all') await execute(`UPDATE notifications SET read_at = now() WHERE user_id = $1 AND read_at IS NULL`, [userId]);
  else await execute(`UPDATE notifications SET read_at = now() WHERE user_id = $1 AND id = ANY($2::uuid[])`, [userId, ids]);
}

export async function clear(userId: string): Promise<void> {
  await execute(`DELETE FROM notifications WHERE user_id = $1`, [userId]);
}
