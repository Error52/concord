import { query, queryOne, tx, type Queryable } from '../db/pool.js';
import { emit } from '../websocket/bus.js';
import { Ev } from '../websocket/events.js';
import {randomUUID} from 'node:crypto';

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
    const result=await tx(async db=>{
    const revision=await advance(userId,db);
    const row = await queryOne<Row>(
      `INSERT INTO notifications (user_id, type, data) VALUES ($1, $2, $3) RETURNING id, type, data, read_at, created_at`,
      [userId, type, JSON.stringify(data)],
      db,
    );
    return {...toDto(row!),revision,unread:await unreadCount(userId,db)};
    });
    await emit(Ev.NotificationNew, result, { users: [userId] });
  }
}

export async function list(userId: string, limit = 50) {
  return tx(async db=>{
  const state=await queryOne<{notification_revision:string}>(`SELECT notification_revision FROM users WHERE id=$1 FOR SHARE`,[userId],db);
  const rows = await query<Row>(
    `SELECT id, type, data, read_at, created_at FROM notifications WHERE user_id = $1 ORDER BY created_at DESC,id DESC LIMIT $2`,
    [userId, Math.min(limit, 100)],
    db,
  );
  return { items: rows.map(toDto), unread: await unreadCount(userId,db),revision:state?.notification_revision??'0' };
  });
}

async function advance(userId:string,db:Queryable):Promise<string>{
  return (await queryOne<{notification_revision:string}>(`UPDATE users SET notification_revision=notification_revision+1 WHERE id=$1 RETURNING notification_revision`,[userId],db))!.notification_revision;
}
async function unreadCount(userId:string,db:Queryable):Promise<number>{
  return (await queryOne<{n:number}>(`SELECT count(*)::int AS n FROM notifications WHERE user_id=$1 AND read_at IS NULL`,[userId],db))!.n;
}
export interface NotificationMutation {mutationId:string;ids:string[];unreadChanged:number;revision:string;unread:number}
export async function markRead(userId: string, ids: string[] | 'all'): Promise<NotificationMutation> {
  const result=await tx(async db=>{
  const revision=await advance(userId,db);
  const rows=await query<{id:string}>(`UPDATE notifications SET read_at=now() WHERE user_id=$1 AND read_at IS NULL
    AND ($2::uuid[] IS NULL OR id=ANY($2::uuid[])) RETURNING id`,[userId,ids==='all'?null:ids],db);
  return {mutationId:randomUUID(),ids:rows.map(r=>r.id),unreadChanged:rows.length,revision,unread:await unreadCount(userId,db)};
  });
  await emit(Ev.NotificationRead,result,{users:[userId]});return result;
}

export async function clear(userId: string): Promise<NotificationMutation> {
  const result=await tx(async db=>{
  const revision=await advance(userId,db);
  const rows=await query<{id:string;read_at:Date|null}>(`DELETE FROM notifications WHERE user_id=$1 RETURNING id,read_at`,[userId],db);
  return {mutationId:randomUUID(),ids:rows.map(r=>r.id),unreadChanged:rows.filter(r=>r.read_at===null).length,revision,unread:0};
  });
  await emit(Ev.NotificationClear,result,{users:[userId]});return result;
}
