import { execute, query, queryOne, tx, pool, type Queryable } from '../db/pool.js';
import { redis } from '../redis.js';
import { config } from '../config.js';
import { Errors, AppError } from '../http/errors.js';
import { Perm, has } from '../models/permissions.js';
import { getAccess, requireChannel, requireManageableMember } from './permissionService.js';
import { loadPublicUser } from '../repositories/userRepo.js';
import { emit, type Target } from '../websocket/bus.js';
import { Ev } from '../websocket/events.js';
import { allowedPublishSources, applyModeration, createJoinToken, listParticipants, removeParticipant, roomInstances, type LkParticipant, type WebhookEvent } from '../webrtc/livekit.js';
import { audit, AuditAction } from './auditService.js';
import { log } from '../logger.js';
import type { VoiceStateDTO } from '../models/dto.js';
import { recordEndedCall } from './callService.js';

/**
 * Voice occupancy lives in Redis (it is ephemeral and changes often):
 *   voice:user:<userId>        JSON VoiceStateDTO   (a user is in at most one room)
 *   voice:room:<channelId>     SET of userIds
 *   voice:mod:<serverId>:<uid> JSON {serverMute, serverDeaf}  (persists across sessions, like Discord)
 * Durable history goes to voice_sessions / voice_participants.
 */
const userKey = (u: string): string => `voice:user:${u}`;
const roomKey = (c: string): string => `voice:room:${c}`;
const modKey = (s: string, u: string): string => `voice:mod:${s}:${u}`;
const instanceKey = (u: string): string => `voice:instance:${u}`;
interface ParticipantInstance { channelId:string;participantSid?:string;roomSid?:string;sessionId?:string }
export const roomName = (channelId: string): string => `ch_${channelId}`;
const channelFromRoom = (room: string): string | null => (/^ch_([0-9a-f-]{36})$/.exec(room)?.[1] ?? null);
const UUID_PATTERN=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// One upgrade window per backend process; SFU token refresh must not perpetuate unbound media.
const LEGACY_MEDIA_UNTIL=Date.now()+5*60_000;

function mediaSessionId(metadata:string|undefined):string|null|false{
  if(!metadata)return Date.now()<LEGACY_MEDIA_UNTIL?null:false;
  try{
    const value:unknown=JSON.parse(metadata);
    if(!value||typeof value!=='object'||Array.isArray(value))return false;
    if(!('sessionId' in value))return Date.now()<LEGACY_MEDIA_UNTIL?null:false;
    return typeof value.sessionId==='string'&&UUID_PATTERN.test(value.sessionId)?value.sessionId:false;
  }catch{return false;}
}

async function activeMediaSession(userId:string,sessionId:string,db:Queryable=pool):Promise<boolean>{
  if(!UUID_PATTERN.test(userId)||!UUID_PATTERN.test(sessionId))return false;
  // Rotation revokes the original refresh row; its access/media token still belongs to the active family.
  return !!await queryOne(`SELECT 1 FROM sessions original WHERE original.id=$1 AND original.user_id=$2
    AND EXISTS(SELECT 1 FROM sessions active WHERE active.family_id=original.family_id
      AND active.revoked_at IS NULL AND active.expires_at>now())`,[sessionId,userId],db);
}

async function removeObservedParticipant(userId:string,channelId:string,expected:LkParticipant):Promise<boolean>{
  const current=(await listParticipants(roomName(channelId))).find(p=>p.identity===userId);
  if(!current||current.sid!==expected.sid||current.metadata!==expected.metadata)return false;
  await removeParticipant(roomName(channelId),userId);
  return true;
}

async function getState(userId: string): Promise<VoiceStateDTO | null> {
  const raw = await redis.get(userKey(userId));
  return raw ? (JSON.parse(raw) as VoiceStateDTO) : null;
}

/** Merge into the still-current room without overwriting concurrent self/moderation changes. */
async function patchState(userId:string,channelId:string,patch:object,participantSid?:string):Promise<{before:VoiceStateDTO;after:VoiceStateDTO}|null>{
  const raw=await redis.eval(`local raw=redis.call('GET',KEYS[1]);if not raw then return nil end
    local state=cjson.decode(raw);if state.channelId~=ARGV[1] then return nil end
    if ARGV[3]~='' then local current=redis.call('GET',KEYS[2]);if not current then return nil end
      local instance=cjson.decode(current);if instance.channelId~=ARGV[1] or instance.participantSid~=ARGV[3] then return nil end end
    local before=raw;for key,value in pairs(cjson.decode(ARGV[2])) do state[key]=value end
    local after=cjson.encode(state);redis.call('SET',KEYS[1],after);return {before,after}`,2,userKey(userId),instanceKey(userId),channelId,JSON.stringify(patch),participantSid??'') as [string,string]|null;
  return raw?{before:JSON.parse(raw[0]),after:JSON.parse(raw[1])}:null;
}

async function targetFor(channelId: string, serverId: string | null,db:Queryable=pool): Promise<Target> {
  if (serverId) return { server: serverId };
  const peers = await query<{ user_id: string }>(`SELECT user_id FROM channel_members WHERE channel_id = $1`, [channelId],db);
  return { users: peers.map((p) => p.user_id) };
}

async function getModeration(serverId: string | null, userId: string): Promise<{ serverMute: boolean; serverDeaf: boolean }> {
  if (!serverId) return { serverMute: false, serverDeaf: false };
  const raw = await redis.get(modKey(serverId, userId));
  return raw ? (JSON.parse(raw) as { serverMute: boolean; serverDeaf: boolean }) : { serverMute: false, serverDeaf: false };
}

/** Issues a LiveKit token after checking CONNECT/SPEAK/VIDEO permissions (or DM participation). */
export async function join(userId: string, channelId: string,sessionId?:string) {
  if(sessionId&&!await activeMediaSession(userId,sessionId))throw Errors.unauthorized('Сессия истекла');
  const ca = await requireChannel(channelId, userId);
  if (ca.channel.type === 'text') throw Errors.badRequest('Это текстовый канал');
  const serverId = ca.channel.server_id;
  if (ca.access && !has(ca.access.perms, Perm.CONNECT)) {
    throw Errors.forbidden(ca.access.timedOutUntil ? 'Вы временно ограничены (тайм-аут)' : 'Нет права подключаться к этому каналу');
  }
  if (!serverId) {
    const blocked = await queryOne(
      `SELECT 1 FROM blocks WHERE (blocker_id = $1 AND blocked_id = ANY($2::uuid[])) OR (blocked_id = $1 AND blocker_id = ANY($2::uuid[]))`,
      [userId, ca.dmPeers.filter((p) => p !== userId)],
    );
    if (blocked) throw Errors.forbidden('Звонок недоступен');
  }
  const user = await loadPublicUser(userId);
  const mod = await getModeration(serverId, userId);
  const canSpeak = !ca.access || has(ca.access.perms, Perm.SPEAK);
  const canVideo = !ca.access || has(ca.access.perms, Perm.VIDEO);
  const sources=allowedPublishSources({...mod,allowSpeak:canSpeak,allowVideo:canVideo});

  const token = createJoinToken({
    room: roomName(channelId),
    identity: userId,
    name: user?.displayName || user?.username || 'user',
    metadata: JSON.stringify({ avatarUrl: user?.avatarUrl ?? null, username: user?.username,...(sessionId?{sessionId}:{}) }),
    canPublish: sources.length>0,
    canSubscribe: !mod.serverDeaf,
    sources,
  });
  return {
    token,
    url: config.LIVEKIT_PUBLIC_URL,
    room: roomName(channelId),
    channelId,
    serverId,
    serverMute: mod.serverMute,
    serverDeaf: mod.serverDeaf,
  };
}

/** Marks a user present in a room (from the client's "connected" op or the LiveKit webhook). */
export async function markJoined(userId: string, channelId: string, instance?:Omit<ParticipantInstance,'channelId'>,verifyPresence=false): Promise<boolean> {
  let afterLeave:(()=>Promise<void>)|undefined;
  const joined=await tx(async db=>{
  await execute(`SELECT pg_advisory_xact_lock(hashtextextended($1,0))`,[`voice-state:${userId}`],db);
  // A delayed join for an old participant must not resurrect it or replace a newer room.
  if(instance?.participantSid||verifyPresence){
    const current=(await listParticipants(roomName(channelId))).find(p=>p.identity===userId);
    if(!current||(instance?.participantSid&&current.sid!==instance.participantSid))return false;
    const sessionId=mediaSessionId(current.metadata);
    if(sessionId===false||(sessionId&&!await activeMediaSession(userId,sessionId,db))){
      if(await removeObservedParticipant(userId,channelId,current)){
        const raw=await redis.get(instanceKey(userId));const old=raw?JSON.parse(raw) as ParticipantInstance:null;
        if(!old?.participantSid||old.participantSid===current.sid)afterLeave=await markLeftLocked(userId,channelId,db);
      }
      return false;
    }
    instance={...instance,participantSid:current.sid,...(sessionId?{sessionId}:{})};
  }
  const ch = await queryOne<{ server_id: string | null }>(`SELECT server_id FROM channels WHERE id = $1`, [channelId],db);
  if (!ch) return false;
  const prev = await getState(userId);
  if (prev?.channelId === channelId) {
    if(instance){
      const raw=await redis.get(instanceKey(userId));const old=raw?JSON.parse(raw) as ParticipantInstance:null;
      const roomSid=instance.roomSid??(old?.participantSid===instance.participantSid?old?.roomSid:undefined);
      await redis.set(instanceKey(userId),JSON.stringify({channelId,...instance,roomSid}));
    }
    return true;
  }
  // A swap touches two active-session rows. Acquire both rooms in a stable order.
  for(const id of [...new Set([channelId,...(prev?[prev.channelId]:[])])].sort()){
    await execute(`SELECT pg_advisory_xact_lock(hashtextextended($1,0))`,[`voice-room:${id}`],db);
  }
  if (prev) {
    await emit(Ev.VoiceForceDisconnect,{channelId:prev.channelId},{users:[userId]});
    await removeParticipant(roomName(prev.channelId),userId);
    afterLeave=await markLeftLocked(userId,prev.channelId,db);
  }
  const mod = await getModeration(ch.server_id, userId);
  const state: VoiceStateDTO = {
    userId,
    channelId,
    serverId: ch.server_id,
    selfMute: false,
    selfDeaf: false,
    serverMute: mod.serverMute,
    serverDeaf: mod.serverDeaf,
    camera: false,
    screen: false,
    joinedAt: new Date().toISOString(),
  };
  const write=redis.multi().set(userKey(userId), JSON.stringify(state)).sadd(roomKey(channelId), userId);
  if(instance)write.set(instanceKey(userId),JSON.stringify({channelId,...instance}));else write.del(instanceKey(userId));
  await write.exec();
  await recordJoin(userId, channelId,db);
  await emit(Ev.VoiceJoin, state, await targetFor(channelId, ch.server_id,db));
  return true;
  });
  await afterLeave?.();
  return joined;
}

export async function markLeft(userId: string, channelId?: string): Promise<void> {
  const afterLeave=await tx(async db=>{
    await execute(`SELECT pg_advisory_xact_lock(hashtextextended($1,0))`,[`voice-state:${userId}`],db);
    return markLeftLocked(userId,channelId,db);
  });
  await afterLeave?.();
}
async function markLeftLocked(userId:string,channelId:string|undefined,db:Queryable):Promise<(()=>Promise<void>)|undefined>{
  const state = await getState(userId);
  if (!state || (channelId && state.channelId !== channelId)) return;
  await execute(`SELECT pg_advisory_xact_lock(hashtextextended($1,0))`,[`voice-room:${state.channelId}`],db);
  const removed=await redis.eval(`local raw=redis.call('GET',KEYS[1]);if not raw or cjson.decode(raw).channelId~=ARGV[1] then return 0 end
    redis.call('DEL',KEYS[1],KEYS[3]);redis.call('SREM',KEYS[2],ARGV[2]);return 1`,3,userKey(userId),roomKey(state.channelId),instanceKey(userId),state.channelId,userId);
  if(!removed)return;
  const afterLeave=await recordLeave(userId, state.channelId,db);
  if (state.screen) await emit(Ev.ScreenStop, { userId, channelId: state.channelId }, await targetFor(state.channelId, state.serverId,db));
  await emit(Ev.VoiceLeave, { userId, channelId: state.channelId, serverId: state.serverId }, await targetFor(state.channelId, state.serverId,db));
  return afterLeave;
}

export async function updateSelfState(
  userId: string,
  patch: Partial<Pick<VoiceStateDTO, 'selfMute' | 'selfDeaf' | 'camera' | 'screen'>>,
  expectedChannelId?:string,
  participantSid?:string,
): Promise<void> {
  const state = await getState(userId);
  if (!state||(expectedChannelId&&state.channelId!==expectedChannelId)) return;
  const result=await patchState(userId,state.channelId,patch,participantSid);if(!result)return;
  const screenChanged = result.before.screen !== result.after.screen;
  const next=result.after;
  const target = await targetFor(state.channelId, state.serverId);
  await emit(Ev.VoiceState, next, target);
  if (screenChanged) await emit(next.screen ? Ev.ScreenStart : Ev.ScreenStop, { userId, channelId: state.channelId }, target);
}

/** Relays the client's real-time speaking flag (derived from its audio analyser) to the sidebar of other members. */
export async function relaySpeaking(userId: string, speaking: boolean): Promise<void> {
  const state = await getState(userId);
  if (!state) return;
  await emit(Ev.VoiceSpeaking, { userId, channelId: state.channelId, speaking }, await targetFor(state.channelId, state.serverId), userId);
}

export async function voiceStatesForServer(serverId: string): Promise<VoiceStateDTO[]> {
  const channels = await query<{ id: string }>(`SELECT id FROM channels WHERE server_id = $1 AND type = 'voice'`, [serverId]);
  return statesForChannels(channels.map((c) => c.id));
}

export async function statesForChannels(channelIds: string[]): Promise<VoiceStateDTO[]> {
  const out: VoiceStateDTO[] = [];
  for (const channelId of channelIds) {
    const members = await redis.smembers(roomKey(channelId));
    if (members.length === 0) continue;
    const raw = await redis.mget(...members.map(userKey));
    raw.forEach((r, i) => {
      if (!r) {
        void redis.srem(roomKey(channelId), members[i]!);
        return;
      }
      const s = JSON.parse(r) as VoiceStateDTO;
      if (s.channelId === channelId) out.push(s);
    });
  }
  return out;
}

export async function myState(userId: string): Promise<VoiceStateDTO | null> {
  return getState(userId);
}

// ─────────────── moderation ───────────────

/** Role changes must also reach participants that already have a LiveKit token. */
export async function syncVoicePermissions(serverId: string, userIds?: string[]): Promise<void> {
  const states = userIds
    ? (await Promise.all(userIds.map(getState))).filter((s): s is VoiceStateDTO => s?.serverId === serverId)
    : await voiceStatesForServer(serverId);
  // Bound SFU calls and pool occupancy; serialize each participant across API workers.
  for (let i = 0; i < states.length; i += 4) await Promise.all(states.slice(i, i + 4).map(async (expected) => tx(async db => {
    await execute(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [`voice-permissions:${expected.userId}`], db);
    const state = await getState(expected.userId);
    if (state?.serverId !== serverId || state.channelId !== expected.channelId) return;
    const access = await getAccess(serverId, state.userId, db);
    if (!access || !has(access.perms, Perm.CONNECT)) {
      await forceDisconnectUser(state.userId, serverId, state.channelId);
      return;
    }
    const mod = await getModeration(serverId, state.userId);
    try {
      await applyModeration(roomName(state.channelId), state.userId, {
        ...mod, allowSpeak: has(access.perms, Perm.SPEAK), allowVideo: has(access.perms, Perm.VIDEO),
      });
    } catch (err) {
      log.warn('livekit role permissions failed; disconnecting participant', { err });
      await forceDisconnectUser(state.userId, serverId, state.channelId);
    }
  })));
}

export async function setServerMute(actorId: string, serverId: string, targetId: string, patch: { serverMute?: boolean; serverDeaf?: boolean }) {
  await requireManageableMember(serverId, actorId, targetId, Perm.MANAGE_VOICE,true);
  const next = await tx(async db => {
  await execute(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [`voice-permissions:${targetId}`], db);
  const current = await getModeration(serverId, targetId);
  const next = { serverMute: patch.serverMute ?? current.serverMute, serverDeaf: patch.serverDeaf ?? current.serverDeaf };
  if (next.serverMute || next.serverDeaf) await redis.set(modKey(serverId, targetId), JSON.stringify(next));
  else await redis.del(modKey(serverId, targetId));
  const state = await getState(targetId);
  if (state?.serverId === serverId) {
    const access=await getAccess(serverId,targetId,db);
    const connected=!!access&&has(access.perms,Perm.CONNECT);
    await applyModeration(roomName(state.channelId), targetId, {
      ...next,allowVideo:connected&&has(access!.perms,Perm.VIDEO),allowSpeak:connected&&has(access!.perms,Perm.SPEAK),
    }).catch(async(err) => {
      log.warn('livekit moderation failed; disconnecting participant', { err });
      await forceDisconnectUser(targetId,serverId,state.channelId);
    });
    const updated=await patchState(targetId,state.channelId,next);
    if(updated)await emit(Ev.VoiceState, updated.after, { server: serverId });
  }
  return next;
  });
  await audit(serverId, actorId, AuditAction.VoiceMute, { type: 'user', id: targetId }, next);
  return next;
}

export async function moveUser(actorId: string, serverId: string, targetId: string, channelId: string): Promise<void> {
  await requireManageableMember(serverId, actorId, targetId, Perm.MANAGE_VOICE,true);
  const ch = await queryOne<{ type: string }>(`SELECT type FROM channels WHERE id = $1 AND server_id = $2`, [channelId, serverId]);
  if (ch?.type !== 'voice') throw Errors.notFound('Голосовой канал');
  const state = await getState(targetId);
  if (state?.serverId !== serverId) throw Errors.badRequest('Пользователь не в голосовом канале этого сервера');
  // The client reconnects to the new room itself; the old room is closed for it server-side.
  await emit(Ev.VoiceForceMove, { channelId, serverId }, { users: [targetId] });
  await removeParticipant(roomName(state.channelId), targetId);
  await audit(serverId, actorId, AuditAction.VoiceMove, { type: 'user', id: targetId }, { channelId });
}

export async function disconnectUser(actorId: string, serverId: string, targetId: string): Promise<void> {
  await requireManageableMember(serverId, actorId, targetId, Perm.MANAGE_VOICE,true);
  await forceDisconnectUser(targetId, serverId);
  await audit(serverId, actorId, AuditAction.VoiceDisconnect, { type: 'user', id: targetId });
}

/** Removes a user from voice in the given server (kick/ban/timeout/disconnect). */
export async function forceDisconnectUser(targetId: string, serverId: string,channelId?:string): Promise<void> {
  const state = await getState(targetId);
  if (state?.serverId !== serverId||(channelId&&state.channelId!==channelId)) return;
  await emit(Ev.VoiceForceDisconnect, { channelId: state.channelId }, { users: [targetId] });
  await removeParticipant(roomName(state.channelId), targetId);
  await markLeft(targetId, state.channelId);
}

// ─────────────── LiveKit webhooks (authoritative join/leave) ───────────────

/** Shared by signed webhooks and reconciliation of participants reported by the SFU. */
export async function acceptParticipant(identity:string,channelId:string,instance?:(Omit<ParticipantInstance,'channelId'>&{metadata?:string})):Promise<void>{
  try { await join(identity, channelId); }
  catch (err) {
    if (!(err instanceof AppError)) throw err;
    await emit(Ev.VoiceForceDisconnect, { channelId }, { users: [identity] });
    await removeParticipant(roomName(channelId), identity);
    await markLeft(identity, channelId);
    return;
  }
  const {metadata,...details}=instance??{};
  await markJoined(identity, channelId,instance?details:undefined,metadata!==undefined);
  const state = await getState(identity);
  if (state?.serverId && state.channelId === channelId) await syncVoicePermissions(state.serverId, [identity]);
}

/** A name can refer to a new participant/room by the time an old webhook is delivered. */
async function markWebhookLeft(identity:string,expectedChannelId:string|undefined,expected:Omit<ParticipantInstance,'channelId'>):Promise<void>{
  const afterLeave=await tx(async db=>{
    await execute(`SELECT pg_advisory_xact_lock(hashtextextended($1,0))`,[`voice-state:${identity}`],db);
    const state=await getState(identity);
    if(!state||(expectedChannelId&&state.channelId!==expectedChannelId))return;
    const channelId=state.channelId;
    const raw=await redis.get(instanceKey(identity));
    const current=raw?JSON.parse(raw) as ParticipantInstance:null;
    if(current?.channelId===channelId&&(
      (expected.participantSid&&current.participantSid&&expected.participantSid!==current.participantSid)||
      (expected.roomSid&&current.roomSid&&expected.roomSid!==current.roomSid)
    ))return;
    // The client may announce a reconnect before its new join webhook arrives.
    // Never remove a participant that the SFU currently reports as present.
    try{if((await listParticipants(roomName(channelId))).some(p=>p.identity===identity))return;}
    catch(err){log.warn('livekit leave verification failed; waiting for reconciliation',{err});return;}
    return markLeftLocked(identity,channelId,db);
  });
  await afterLeave?.();
}

/** Clients announce before closing their transport; only the departed SFU incarnation may leave. */
export async function leaveClient(userId:string,expectedChannelId?:string,participantSid?:string):Promise<void>{
  await markWebhookLeft(userId,expectedChannelId,{participantSid});
}

/** Revoking one browser family must not disconnect an SFU participant from another device. */
export async function disconnectRevokedSessions(sessionIds:string[]):Promise<void>{
  const revoked=new Set(sessionIds);if(!revoked.size)return;
  const owners=await query<{user_id:string}>(`SELECT DISTINCT user_id FROM sessions WHERE id=ANY($1::uuid[])`,[sessionIds]);
  const states=(await Promise.all(owners.map(owner=>getState(owner.user_id)))).filter((s):s is VoiceStateDTO=>!!s);
  // A revoked token arriving before its join webhook is checked by acceptParticipant/reconciliation.
  for(const channelId of new Set(states.map(state=>state.channelId))){
    try{
      const participants=await listParticipants(roomName(channelId));
      for(const participant of participants){
        const sessionId=mediaSessionId(participant.metadata);
        if(!sessionId||!revoked.has(sessionId))continue;
        if(await removeObservedParticipant(participant.identity,channelId,participant)){
          await markWebhookLeft(participant.identity,channelId,{participantSid:participant.sid});
        }
      }
    }catch(err){log.warn('livekit session revocation deferred until reconciliation',{err,channelId});}
  }
}

export async function handleWebhook(ev: WebhookEvent): Promise<void> {
  const room = ev.room?.name;
  const channelId = room ? channelFromRoom(room) : null;
  if (!channelId) return;
  const identity = ev.participant?.identity;
  switch (ev.event) {
    case 'participant_joined':
      if (identity) await acceptParticipant(identity,channelId,{participantSid:ev.participant?.sid,roomSid:ev.room?.sid,metadata:ev.participant?.metadata});
      break;
    case 'participant_left':
      if (identity) await markWebhookLeft(identity,channelId,{participantSid:ev.participant?.sid,roomSid:ev.room?.sid});
      break;
    case 'room_finished': {
      try{
        const current=(await roomInstances()).find(r=>r.name===room);
        if(current&&ev.room?.sid&&current.sid&&current.sid!==ev.room.sid)return;
      }catch(err){log.warn('livekit room verification failed; waiting for reconciliation',{err});return;}
      const members = await redis.smembers(roomKey(channelId));
      for (const m of members) await markWebhookLeft(m,channelId,{roomSid:ev.room?.sid});
      await tx(async db=>{
        await execute(`SELECT pg_advisory_xact_lock(hashtextextended($1,0))`,[`voice-room:${channelId}`],db);
        if(await redis.scard(roomKey(channelId))===0)await execute(`UPDATE voice_sessions SET ended_at = now() WHERE room_name = $1 AND ended_at IS NULL`, [room],db);
      });
      break;
    }
    default:
      break;
  }
}

async function recordJoin(userId: string, channelId: string,db:Queryable): Promise<void> {
  const room = roomName(channelId);
  const session = await queryOne<{ id: string }>(
    `INSERT INTO voice_sessions (channel_id, room_name) VALUES ($1,$2)
       ON CONFLICT (room_name) WHERE ended_at IS NULL DO UPDATE SET room_name=EXCLUDED.room_name RETURNING id`,
    [channelId, room],
    db,
  );
  if (session) await execute(`INSERT INTO voice_participants (session_id, user_id) VALUES ($1, $2)`, [session.id, userId],db);
}

async function recordLeave(userId: string, channelId: string,db:Queryable): Promise<(()=>Promise<void>)|undefined> {
  const room = roomName(channelId);
  await execute(
    `UPDATE voice_participants SET left_at = now()
      WHERE user_id = $1 AND left_at IS NULL AND session_id IN (SELECT id FROM voice_sessions WHERE room_name = $2 AND ended_at IS NULL)`,
    [userId, room],
    db,
  );
  const remaining = await redis.scard(roomKey(channelId));
  if (remaining === 0) {
    const session=await queryOne<{id:string}>(`UPDATE voice_sessions SET ended_at = now() WHERE room_name = $1 AND ended_at IS NULL RETURNING id`, [room],db);
    if(session)return recordEndedCall(channelId,userId,session.id,db);
  }
}
