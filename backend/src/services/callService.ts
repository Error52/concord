import { redis } from '../redis.js';
import { Errors } from '../http/errors.js';
import { requireChannel } from './permissionService.js';
import { loadPublicUser } from '../repositories/userRepo.js';
import { emit } from '../websocket/bus.js';
import { Ev } from '../websocket/events.js';
import { notify } from './notificationService.js';
import { postSystem } from './messageService.js';
import { statesForChannels } from './voiceService.js';
import { queryOne } from '../db/pool.js';
import {randomUUID} from 'node:crypto';

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
  if(await redis.set(ringKey(channelId), JSON.stringify(ring), 'EX', RING_TTL, 'NX')!=='OK')return;
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
  const ring=await consumeRing(channelId,userId,ringId,true);if(!ring)return;
  await emit(Ev.CallAccepted, { channelId, userId,ringId:ring.id }, { users: peers });
}

export async function decline(channelId: string, userId: string,ringId?:string): Promise<void> {
  const peers = await dmPeers(channelId, userId);
  const ring=await consumeRing(channelId,userId,ringId,true);if(!ring)return;
  await emit(Ev.CallDeclined, { channelId, userId,ringId:ring.id }, { users: peers });
  await postSystem(channelId, ring.callerId, 'call:missed');
}

/** Ends ringing and, if nobody remains in the room, records the call in the chat. */
export async function end(channelId: string, userId: string, durationSec: number | null): Promise<void> {
  const peers = await dmPeers(channelId, userId);
  // An old participant leaving must not cancel a new call started by the other side.
  const raw=await redis.get(ringKey(channelId));
  const pending=raw?JSON.parse(raw) as Ring:null;
  const ring=pending?.callerId===userId?await consumeRing(channelId,userId,pending.id):null;
  const remaining = (await statesForChannels([channelId])).filter((s) => s.userId !== userId);
  await emit(Ev.CallEnded, { channelId, userId, ringId:ring?.id, remaining: remaining.length }, { users: peers });
  if (remaining.length === 0) {
    if (ring) await postSystem(channelId, userId, 'call:missed');
    else if (durationSec && durationSec > 0) await postSystem(channelId, userId, `call:ended:${Math.round(durationSec)}`);
  }
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
