import { execute, query, queryOne, tx,type Queryable } from '../db/pool.js';
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

export async function list(userId: string,db?:Queryable): Promise<RelationDTO[]> {
  // One MVCC snapshot cannot combine an old request with a newly created friendship/block.
  const rows=await query<{type:RelationType;other:string;created_at:Date;id:string|null}>(
    `SELECT 'friend'::text AS type,CASE WHEN user_a=$1 THEN user_b ELSE user_a END AS other,created_at,NULL::uuid AS id
      FROM friendships WHERE user_a=$1 OR user_b=$1
     UNION ALL SELECT 'incoming',from_id,created_at,id FROM friend_requests WHERE to_id=$1
     UNION ALL SELECT 'outgoing',to_id,created_at,id FROM friend_requests WHERE from_id=$1
     UNION ALL SELECT 'blocked',blocked_id,created_at,NULL::uuid FROM blocks WHERE blocker_id=$1`,[userId],db);
  const users = await loadPublicUsers(rows.map((r) => r.other),db);
  const out: RelationDTO[] = [];
  for(const r of rows){
    const user = users.get(r.other);
    if (user) out.push({ id: r.other, type:r.type, user, requestId: r.id??undefined, since: r.created_at.toISOString() });
  }
  return out;
}

async function isBlockedEitherWay(a: string, b: string,db?:Queryable): Promise<boolean> {
  return !!(await queryOne(
    `SELECT 1 FROM blocks WHERE (blocker_id = $1 AND blocked_id = $2) OR (blocker_id = $2 AND blocked_id = $1)`,
    [a, b],
    db,
  ));
}

async function areFriends(a: string, b: string,db?:Queryable): Promise<boolean> {
  const [x, y] = pair(a, b);
  return !!(await queryOne(`SELECT 1 FROM friendships WHERE user_a = $1 AND user_b = $2`, [x, y],db));
}

async function withPair<T>(a:string,b:string,fn:(db:Queryable)=>Promise<T>):Promise<T>{
  return tx(async db=>{
    await execute(`SELECT pg_advisory_xact_lock(hashtextextended($1,0))`,[`relationship:${pair(a,b).join(':')}`],db);
    return fn(db);
  });
}

async function acceptLocked(userId:string,otherId:string,db:Queryable):Promise<boolean>{
  const removed=await execute(`DELETE FROM friend_requests WHERE from_id=$1 AND to_id=$2`,[otherId,userId],db);
  if(!removed)return false;
  await execute(`DELETE FROM friend_requests WHERE from_id=$1 AND to_id=$2`,[userId,otherId],db);
  const [a,b]=pair(userId,otherId);
  await execute(`INSERT INTO friendships (user_a,user_b) VALUES ($1,$2) ON CONFLICT DO NOTHING`,[a,b],db);
  return true;
}

async function pushRelations(userIds: string[]): Promise<void> {
  for (const id of new Set(userIds))await tx(async db=>{
    // Serialize snapshot publication, while mutations retain their independent pair locks.
    await execute(`SELECT pg_advisory_xact_lock(hashtextextended($1,0))`,[`relationship-snapshot:${id}`],db);
    await emit(Ev.FriendUpdate, await list(id,db), { users: [id] });
  });
}

/** Sends a request by username or id. If the other side already asked us, this accepts instead. */
export async function request(userId: string, target: { username?: string; userId?: string }): Promise<RelationDTO[]> {
  const targetRow = target.userId ? { id: target.userId } : target.username ? await findByUsername(target.username) : null;
  if (!targetRow || !(await loadPublicUser(targetRow.id))) throw Errors.notFound('Пользователь');
  const otherId = targetRow.id;
  if (otherId === userId) throw Errors.badRequest('Нельзя добавить в друзья самого себя');
  const accepted=await withPair(userId,otherId,async db=>{
    if(await isBlockedEitherWay(userId,otherId,db))throw Errors.forbidden('Не удалось отправить запрос в друзья');
    if(await areFriends(userId,otherId,db))throw Errors.conflict('ALREADY_FRIENDS','Вы уже друзья');
    const reverse=await queryOne<{id:string}>(`SELECT id FROM friend_requests WHERE from_id = $1 AND to_id = $2`,[otherId,userId],db);
    if(reverse)return acceptLocked(userId,otherId,db);
    const inserted=await execute(`INSERT INTO friend_requests (from_id,to_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`,[userId,otherId],db);
    if(!inserted)throw Errors.conflict('REQUEST_EXISTS','Запрос уже отправлен');
    return false;
  });
  const me = await loadPublicUser(userId);
  if(accepted)await notify([otherId],'friend_accept',{user:me});
  else{
    await emit(Ev.FriendRequest, { from: me }, { users: [otherId] });
    await notify([otherId], 'friend_request', { from: me });
  }
  await pushRelations([userId, otherId]);
  return list(userId);
}

export async function accept(userId: string, otherId: string): Promise<RelationDTO[]> {
  const ok = await withPair(userId,otherId,async (db) => {
    if(await isBlockedEitherWay(userId,otherId,db))throw Errors.forbidden('Не удалось принять запрос в друзья');
    return acceptLocked(userId,otherId,db);
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
  await withPair(userId,otherId,async (db) => {
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
  await withPair(userId,otherId,async (db) => {
    await execute(`DELETE FROM friend_requests WHERE (from_id = $1 AND to_id = $2) OR (from_id = $2 AND to_id = $1)`, [userId, otherId], db);
    await execute(`DELETE FROM friendships WHERE user_a = $1 AND user_b = $2`, [a, b], db);
    await execute(`INSERT INTO blocks (blocker_id, blocked_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [userId, otherId], db);
  });
  await pushRelations([userId, otherId]);
  return list(userId);
}

export async function unblock(userId: string, otherId: string): Promise<RelationDTO[]> {
  await withPair(userId,otherId,async db=>{await execute(`DELETE FROM blocks WHERE blocker_id = $1 AND blocked_id = $2`, [userId, otherId],db);});
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
