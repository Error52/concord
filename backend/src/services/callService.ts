import { redis } from '../redis.js';
import { Errors } from '../http/errors.js';
import { requireChannel } from './permissionService.js';
import { loadPublicUser } from '../repositories/userRepo.js';
import { emit } from '../websocket/bus.js';
import { Ev } from '../websocket/events.js';
import { notify } from './notificationService.js';
import { execute, query, queryOne, tx, type Queryable } from '../db/pool.js';
import {randomUUID} from 'node:crypto';
import { findMessage, hydrate } from '../repositories/messageRepo.js';
import { log } from '../logger.js';

/**
 * DM call signalling. Media goes through the SFU room of the DM channel; this only rings the
 * other participants and tracks whether a ring is outstanding.
 *   call:ring:<channelId>  JSON { callerId, video, startedAt }  (TTL = ring timeout)
 */
const RING_TTL = 45;
const ringKey = (c: string): string => `call:ring:${c}`;

interface Ring {
  id: string;
  callerId: string;
  video: boolean;
  startedAt: string;
}

async function dmPeers(channelId: string, userId: string): Promise<string[]> {
  const ca = await requireChannel(channelId, userId);
  if (ca.channel.type !== 'dm') throw Errors.badRequest('Звонки доступны только в личных сообщениях');
  return ca.dmPeers;
}

async function isBlocked(userId:string,peers:string[]):Promise<boolean>{
  return !!await queryOne(`SELECT 1 FROM blocks WHERE
    (blocker_id=$1 AND blocked_id=ANY($2::uuid[])) OR (blocked_id=$1 AND blocker_id=ANY($2::uuid[]))`,
    [userId,peers.filter(id=>id!==userId)]);
}

export async function ring(channelId: string, userId: string, video: boolean): Promise<void> {
  const peers = await dmPeers(channelId, userId);
  if(await isBlocked(userId,peers))throw Errors.forbidden('Звонок недоступен');
  const ring: Ring = { id:randomUUID(), callerId: userId, video, startedAt: new Date().toISOString() };
  let created:boolean;
  try{
    created=await tx(async db=>{
      await execute(`SELECT pg_advisory_xact_lock(hashtextextended($1,0))`,[`voice-room:${channelId}`],db);
      if(await redis.set(ringKey(channelId), JSON.stringify(ring), 'EX', RING_TTL, 'NX')!=='OK')return false;
      // The UI announces its SFU join before ringing. Signalling-only API clients
      // retain their existing behaviour without creating a fictitious media session.
      await execute(`UPDATE voice_sessions SET call_ring_id=$2,call_ring_caller_id=$3
        WHERE channel_id=$1 AND ended_at IS NULL`,[channelId,ring.id,userId],db);
      return true;
    });
  }catch(err){
    await consumeRing(channelId,userId,ring.id).catch(()=>undefined);
    throw err;
  }
  if(!created)return;
  const caller = await loadPublicUser(userId);
  const others = peers.filter((p) => p !== userId);
  await emit(Ev.CallIncoming, { id:ring.id, channelId, caller, video, timeoutSec: RING_TTL }, { users: others });
  await notify(others, 'call', { channelId, caller, video });
}

/** Compare and consume in one Redis operation; another tab may already have answered. */
async function consumeRing(channelId:string,userId:string,ringId?:string,calleeOnly=false):Promise<Ring|null>{
  const raw=await redis.eval(`local raw=redis.call('GET',KEYS[1]);if not raw then return nil end
    local ring=cjson.decode(raw)
    if ARGV[1]~='' and ring.id~=ARGV[1] then return nil end
    if ARGV[2]=='1' and ring.callerId==ARGV[3] then return nil end
    redis.call('DEL',KEYS[1]);return raw`,1,ringKey(channelId),ringId??'',calleeOnly?'1':'0',userId) as string|null;
  return raw?JSON.parse(raw) as Ring:null;
}

export async function accept(channelId: string, userId: string,ringId?:string): Promise<void> {
  const peers = await dmPeers(channelId, userId);
  if(await isBlocked(userId,peers))throw Errors.forbidden('Звонок недоступен');
  const ring=await tx(async db=>{
    await execute(`SELECT pg_advisory_xact_lock(hashtextextended($1,0))`,[`voice-room:${channelId}`],db);
    const pending=await consumeRing(channelId,userId,ringId,true);if(!pending)return null;
    await clearRingHistory(channelId,pending.id,db);
    return pending;
  });
  if(!ring)return;
  await emit(Ev.CallAccepted, { channelId, userId,ringId:ring.id }, { users: peers });
}

export async function decline(channelId: string, userId: string,ringId?:string): Promise<void> {
  const peers = await dmPeers(channelId, userId);
  const finished=await finishRing(channelId,userId,ringId,true);if(!finished)return;
  const {ring,afterCommit}=finished;await afterCommit?.();
  await emit(Ev.CallDeclined, { channelId, userId,ringId:ring.id }, { users: peers });
}

/** Stops this caller's outstanding ring. Actual call history follows the last SFU departure. */
export async function end(channelId: string, userId: string, _durationSec: number | null): Promise<void> {
  const peers = await dmPeers(channelId, userId);
  // An old participant leaving must not cancel a new call started by the other side.
  const raw=await redis.get(ringKey(channelId));
  const pending=raw?JSON.parse(raw) as Ring:null;
  if(pending?.callerId!==userId)return;
  const finished=await finishRing(channelId,userId,pending.id,false);if(!finished)return;
  const {ring,afterCommit}=finished;await afterCommit?.();
  await emit(Ev.CallEnded, { channelId, userId, ringId:ring.id, remaining:0 }, { users: peers });
}

async function recordCallMessage(channelId:string,userId:string,content:string,db:Queryable):Promise<()=>Promise<void>>{
  const row=await queryOne<{id:string}>(`INSERT INTO messages(channel_id,author_id,content,kind) VALUES($1,$2,$3,'system') RETURNING id`,[channelId,userId,content],db);
  await execute(`UPDATE channels SET last_message_id=GREATEST(last_message_id,$2::bigint) WHERE id=$1`,[channelId,row!.id],db);
  const read=await queryOne<{channel_id:string;last_read_id:string;mention_count:number;revision:string}>(
    `INSERT INTO read_states(user_id,channel_id,last_read_id,mention_count,revision) VALUES($1,$2,$3,0,1)
      ON CONFLICT(user_id,channel_id) DO UPDATE SET last_read_id=GREATEST(read_states.last_read_id,EXCLUDED.last_read_id),
        mention_count=CASE WHEN EXCLUDED.last_read_id>=read_states.last_read_id THEN 0 ELSE read_states.mention_count END,
        revision=read_states.revision+1 RETURNING channel_id,last_read_id,mention_count,revision`,[userId,channelId,row!.id],db);
  const peers=await query<{user_id:string}>(`SELECT user_id FROM channel_members WHERE channel_id=$1`,[channelId],db);
  return async()=>{
    try{
      const message=await findMessage(row!.id);
      if(message)await emit(Ev.MessageNew,(await hydrate([message],userId))[0],{users:peers.map(p=>p.user_id)});
      await emit(Ev.ReadState,{channelId:read!.channel_id,lastReadId:read!.last_read_id,mentionCount:read!.mention_count,revision:read!.revision},{users:[userId]});
    }catch(err){log.warn('call history broadcast failed; message remains committed',{err,channelId});}
  };
}

async function finishRing(channelId:string,userId:string,ringId:string|undefined,calleeOnly:boolean){
  return tx(async db=>{
    await execute(`SELECT pg_advisory_xact_lock(hashtextextended($1,0))`,[`voice-room:${channelId}`],db);
    const ring=await consumeRing(channelId,userId,ringId,calleeOnly);if(!ring)return null;
    // Participants may connect via the DM sidebar without ever sending call:accept.
    const answered=await queryOne(`SELECT 1 FROM voice_sessions vs WHERE channel_id=$1 AND ended_at IS NULL
      AND (SELECT count(DISTINCT user_id) FROM voice_participants WHERE session_id=vs.id)>=2`,[channelId],db);
    const afterCommit=answered?undefined:await recordCallMessage(channelId,ring.callerId,'call:missed',db);
    await clearRingHistory(channelId,ring.id,db);
    return {ring,afterCommit};
  });
}

async function clearRingHistory(channelId:string,ringId:string,db:Queryable):Promise<void>{
  await execute(`UPDATE voice_sessions SET call_ring_id=NULL,call_ring_caller_id=NULL
    WHERE channel_id=$1 AND ended_at IS NULL AND call_ring_id=$2`,[channelId,ringId],db);
}

/** Called with the room lock held, in the transaction that closes the session. */
export async function recordEndedCall(channelId:string,userId:string,sessionId:string,db:Queryable):Promise<(()=>Promise<void>)|undefined>{
  const channel=await queryOne<{type:string}>(`SELECT type FROM channels WHERE id=$1`,[channelId],db);
  if(channel?.type!=='dm')return;
  const session=await queryOne<{duration:number;participants:string[];call_ring_id:string|null;call_ring_caller_id:string|null}>(
    `SELECT GREATEST(1,round(EXTRACT(EPOCH FROM ended_at-started_at)))::int AS duration,
      ARRAY(SELECT DISTINCT user_id::text FROM voice_participants WHERE session_id=vs.id) AS participants,
      call_ring_id,call_ring_caller_id
      FROM voice_sessions vs WHERE id=$1 AND ended_at IS NOT NULL AND call_logged_at IS NULL`,[sessionId],db);
  if(!session)return;
  const raw=await redis.get(ringKey(channelId));
  const pending=raw?JSON.parse(raw) as Ring:null;
  const ring=pending&&session.participants.includes(pending.callerId)?await consumeRing(channelId,pending.callerId,pending.id):null;
  const answered=session.participants.length>=2;
  if(!answered&&!ring&&!session.call_ring_id)return;
  if(!await execute(`UPDATE voice_sessions SET call_logged_at=now() WHERE id=$1 AND call_logged_at IS NULL`,[sessionId],db))return;
  const authorId=answered?userId:(session.call_ring_caller_id??ring?.callerId??userId);
  const afterMessage=await recordCallMessage(channelId,authorId,answered?`call:ended:${session.duration}`:'call:missed',db);
  const peers=await query<{user_id:string}>(`SELECT user_id FROM channel_members WHERE channel_id=$1`,[channelId],db);
  return async()=>{
    try{
      await afterMessage();
      await emit(Ev.CallEnded,{channelId,userId,ringId:ring?.id??session.call_ring_id??undefined,remaining:0},{users:peers.map(p=>p.user_id)});
    }catch(err){log.warn('completed call broadcast failed; history remains committed',{err,channelId});}
  };
}

export async function pendingRings(userId: string, channelIds: string[]) {
  const out: { id:string;channelId: string; caller: unknown; video: boolean;timeoutSec:number }[] = [];
  for (const channelId of channelIds) {
    const raw = await redis.get(ringKey(channelId));
    if (!raw) continue;
    const r = JSON.parse(raw) as Ring;
    if (r.callerId === userId) continue;
    if(await isBlocked(userId,[r.callerId]))continue;
    const ttl=await redis.ttl(ringKey(channelId));if(ttl<=0)continue;
    out.push({ id:r.id,channelId, caller: await loadPublicUser(r.callerId), video: r.video,timeoutSec:ttl });
  }
  return out;
}
