import { execute, query, queryOne, tx } from '../db/pool.js';
import { Errors } from '../http/errors.js';
import { findByUsername, loadPublicUser, loadPublicUsers } from '../repositories/userRepo.js';
import { emit } from '../websocket/bus.js';
import { Ev } from '../websocket/events.js';
import { notify } from './notificationService.js';
import type { PublicUser } from '../models/dto.js';

export type RelationType = 'friend' | 'incoming' | 'outgoing' | 'blocked';

export interface RelationDTO {
  id: string; // the other user's id
  type: RelationType;
  user: PublicUser;
  requestId?: string;
  since: string;
}

const pair = (a: string, b: string): [string, string] => (a < b ? [a, b] : [b, a]);

export async function list(userId: string): Promise<RelationDTO[]> {
  const [friends, incoming, outgoing, blocked] = await Promise.all([
    query<{ other: string; created_at: Date }>(
      `SELECT CASE WHEN user_a = $1 THEN user_b ELSE user_a END AS other, created_at FROM friendships WHERE user_a = $1 OR user_b = $1`,
      [userId],
    ),
    query<{ id: string; other: string; created_at: Date }>(`SELECT id, from_id AS other, created_at FROM friend_requests WHERE to_id = $1`, [userId]),
    query<{ id: string; other: string; created_at: Date }>(`SELECT id, to_id AS other, created_at FROM friend_requests WHERE from_id = $1`, [userId]),
    query<{ other: string; created_at: Date }>(`SELECT blocked_id AS other, created_at FROM blocks WHERE blocker_id = $1`, [userId]),
  ]);
  const users = await loadPublicUsers([...friends, ...incoming, ...outgoing, ...blocked].map((r) => r.other));
  const out: RelationDTO[] = [];
  const push = (type: RelationType, r: { other: string; created_at: Date; id?: string }) => {
    const user = users.get(r.other);
    if (user) out.push({ id: r.other, type, user, requestId: r.id, since: r.created_at.toISOString() });
  };
  friends.forEach((r) => push('friend', r));
  incoming.forEach((r) => push('incoming', r));
  outgoing.forEach((r) => push('outgoing', r));
  blocked.forEach((r) => push('blocked', r));
  return out;
}

async function isBlockedEitherWay(a: string, b: string): Promise<boolean> {
  return !!(await queryOne(
    `SELECT 1 FROM blocks WHERE (blocker_id = $1 AND blocked_id = $2) OR (blocker_id = $2 AND blocked_id = $1)`,
    [a, b],
  ));
}

async function areFriends(a: string, b: string): Promise<boolean> {
  const [x, y] = pair(a, b);
  return !!(await queryOne(`SELECT 1 FROM friendships WHERE user_a = $1 AND user_b = $2`, [x, y]));
}

async function pushRelations(userIds: string[]): Promise<void> {
  for (const id of userIds) await emit(Ev.FriendUpdate, await list(id), { users: [id] });
}

/** Sends a request by username or id. If the other side already asked us, this accepts instead. */
export async function request(userId: string, target: { username?: string; userId?: string }): Promise<RelationDTO[]> {
  const targetRow = target.userId ? { id: target.userId } : target.username ? await findByUsername(target.username) : null;
  if (!targetRow || !(await loadPublicUser(targetRow.id))) throw Errors.notFound('Пользователь');
  const otherId = targetRow.id;
  if (otherId === userId) throw Errors.badRequest('Нельзя добавить в друзья самого себя');
  if (await isBlockedEitherWay(userId, otherId)) throw Errors.forbidden('Не удалось отправить запрос в друзья');
  if (await areFriends(userId, otherId)) throw Errors.conflict('ALREADY_FRIENDS', 'Вы уже друзья');

  const reverse = await queryOne<{ id: string }>(`SELECT id FROM friend_requests WHERE from_id = $1 AND to_id = $2`, [otherId, userId]);
  if (reverse) return accept(userId, otherId);

  const inserted = await execute(`INSERT INTO friend_requests (from_id, to_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [userId, otherId]);
  if (inserted === 0) throw Errors.conflict('REQUEST_EXISTS', 'Запрос уже отправлен');
  const me = await loadPublicUser(userId);
  await emit(Ev.FriendRequest, { from: me }, { users: [otherId] });
  await notify([otherId], 'friend_request', { from: me });
  await pushRelations([userId, otherId]);
  return list(userId);
}

export async function accept(userId: string, otherId: string): Promise<RelationDTO[]> {
  const ok = await tx(async (db) => {
    const removed = await execute(`DELETE FROM friend_requests WHERE from_id = $1 AND to_id = $2`, [otherId, userId], db);
    if (removed === 0) return false;
    await execute(`DELETE FROM friend_requests WHERE from_id = $1 AND to_id = $2`, [userId, otherId], db);
    const [a, b] = pair(userId, otherId);
    await execute(`INSERT INTO friendships (user_a, user_b) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [a, b], db);
    return true;
  });
  if (!ok) throw Errors.notFound('Запрос в друзья');
  const me = await loadPublicUser(userId);
  await notify([otherId], 'friend_accept', { user: me });
  await pushRelations([userId, otherId]);
  return list(userId);
}

/** Declines an incoming request, cancels an outgoing one, or removes a friend. */
export async function remove(userId: string, otherId: string): Promise<RelationDTO[]> {
  const [a, b] = pair(userId, otherId);
  await tx(async (db) => {
    await execute(`DELETE FROM friend_requests WHERE (from_id = $1 AND to_id = $2) OR (from_id = $2 AND to_id = $1)`, [userId, otherId], db);
    await execute(`DELETE FROM friendships WHERE user_a = $1 AND user_b = $2`, [a, b], db);
  });
  await pushRelations([userId, otherId]);
  return list(userId);
}

export async function block(userId: string, otherId: string): Promise<RelationDTO[]> {
  if (userId === otherId) throw Errors.badRequest('Нельзя заблокировать самого себя');
  if (!(await loadPublicUser(otherId))) throw Errors.notFound('Пользователь');
  const [a, b] = pair(userId, otherId);
  await tx(async (db) => {
    await execute(`DELETE FROM friend_requests WHERE (from_id = $1 AND to_id = $2) OR (from_id = $2 AND to_id = $1)`, [userId, otherId], db);
    await execute(`DELETE FROM friendships WHERE user_a = $1 AND user_b = $2`, [a, b], db);
    await execute(`INSERT INTO blocks (blocker_id, blocked_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [userId, otherId], db);
  });
  await pushRelations([userId, otherId]);
  return list(userId);
}

export async function unblock(userId: string, otherId: string): Promise<RelationDTO[]> {
  await execute(`DELETE FROM blocks WHERE blocker_id = $1 AND blocked_id = $2`, [userId, otherId]);
  await pushRelations([userId]);
  return list(userId);
}

export async function friendIds(userId: string): Promise<string[]> {
  const rows = await query<{ other: string }>(
    `SELECT CASE WHEN user_a = $1 THEN user_b ELSE user_a END AS other FROM friendships WHERE user_a = $1 OR user_b = $1`,
    [userId],
  );
  return rows.map((r) => r.other);
}
