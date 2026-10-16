import { execute, query, queryOne, tx, pool, type Queryable } from '../db/pool.js';
import { redis } from '../redis.js';
import { config } from '../config.js';
import { Errors, AppError } from '../http/errors.js';
import { Perm, has } from '../models/permissions.js';
import { getAccess, requireChannel, requirePerm } from './permissionService.js';
import { loadPublicUser } from '../repositories/userRepo.js';
import { emit, type Target } from '../websocket/bus.js';
import { Ev } from '../websocket/events.js';
import { allowedPublishSources, applyModeration, createJoinToken, removeParticipant, type WebhookEvent } from '../webrtc/livekit.js';
import { audit, AuditAction } from './auditService.js';
import { log } from '../logger.js';
import type { VoiceStateDTO } from '../models/dto.js';

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
export const roomName = (channelId: string): string => `ch_${channelId}`;
const channelFromRoom = (room: string): string | null => (/^ch_([0-9a-f-]{36})$/.exec(room)?.[1] ?? null);

async function getState(userId: string): Promise<VoiceStateDTO | null> {
  const raw = await redis.get(userKey(userId));
  return raw ? (JSON.parse(raw) as VoiceStateDTO) : null;
}

/** Merge into the still-current room without overwriting concurrent self/moderation changes. */
async function patchState(userId:string,channelId:string,patch:object):Promise<{before:VoiceStateDTO;after:VoiceStateDTO}|null>{
  const raw=await redis.eval(`local raw=redis.call('GET',KEYS[1]);if not raw then return nil end
    local state=cjson.decode(raw);if state.channelId~=ARGV[1] then return nil end
    local before=raw;for key,value in pairs(cjson.decode(ARGV[2])) do state[key]=value end
    local after=cjson.encode(state);redis.call('SET',KEYS[1],after);return {before,after}`,1,userKey(userId),channelId,JSON.stringify(patch)) as [string,string]|null;
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
export async function join(userId: string, channelId: string) {
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
    metadata: JSON.stringify({ avatarUrl: user?.avatarUrl ?? null, username: user?.username }),
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
export async function markJoined(userId: string, channelId: string): Promise<void> {
  await tx(async db=>{
  await execute(`SELECT pg_advisory_xact_lock(hashtextextended($1,0))`,[`voice-state:${userId}`],db);
  const ch = await queryOne<{ server_id: string | null }>(`SELECT server_id FROM channels WHERE id = $1`, [channelId],db);
  if (!ch) return;
  const prev = await getState(userId);
  if (prev?.channelId === channelId) return;
  // A swap touches two active-session rows. Acquire both rooms in a stable order.
  for(const id of [...new Set([channelId,...(prev?[prev.channelId]:[])])].sort()){
    await execute(`SELECT pg_advisory_xact_lock(hashtextextended($1,0))`,[`voice-room:${id}`],db);
  }
  if (prev) {
    await emit(Ev.VoiceForceDisconnect,{channelId:prev.channelId},{users:[userId]});
    await removeParticipant(roomName(prev.channelId),userId);
    await markLeftLocked(userId,prev.channelId,db);
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
  await redis.multi().set(userKey(userId), JSON.stringify(state)).sadd(roomKey(channelId), userId).exec();
  await recordJoin(userId, channelId,db);
  await emit(Ev.VoiceJoin, state, await targetFor(channelId, ch.server_id,db));
  });
}

export async function markLeft(userId: string, channelId?: string): Promise<void> {
  await tx(async db=>{
    await execute(`SELECT pg_advisory_xact_lock(hashtextextended($1,0))`,[`voice-state:${userId}`],db);
    await markLeftLocked(userId,channelId,db);
  });
}
async function markLeftLocked(userId:string,channelId:string|undefined,db:Queryable):Promise<void>{
  const state = await getState(userId);
  if (!state || (channelId && state.channelId !== channelId)) return;
  await execute(`SELECT pg_advisory_xact_lock(hashtextextended($1,0))`,[`voice-room:${state.channelId}`],db);
  const removed=await redis.eval(`local raw=redis.call('GET',KEYS[1]);if not raw or cjson.decode(raw).channelId~=ARGV[1] then return 0 end
    redis.call('DEL',KEYS[1]);redis.call('SREM',KEYS[2],ARGV[2]);return 1`,2,userKey(userId),roomKey(state.channelId),state.channelId,userId);
  if(!removed)return;
  await recordLeave(userId, state.channelId,db);
  if (state.screen) await emit(Ev.ScreenStop, { userId, channelId: state.channelId }, await targetFor(state.channelId, state.serverId,db));
  await emit(Ev.VoiceLeave, { userId, channelId: state.channelId, serverId: state.serverId }, await targetFor(state.channelId, state.serverId,db));
}

export async function updateSelfState(
  userId: string,
  patch: Partial<Pick<VoiceStateDTO, 'selfMute' | 'selfDeaf' | 'camera' | 'screen'>>,
): Promise<void> {
  const state = await getState(userId);
  if (!state) return;
  const result=await patchState(userId,state.channelId,patch);if(!result)return;
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
  await requirePerm(serverId, actorId, Perm.MANAGE_VOICE);
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
  await requirePerm(serverId, actorId, Perm.MANAGE_VOICE);
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
  await requirePerm(serverId, actorId, Perm.MANAGE_VOICE);
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
export async function acceptParticipant(identity:string,channelId:string):Promise<void>{
  try { await join(identity, channelId); }
  catch (err) {
    if (!(err instanceof AppError)) throw err;
    await emit(Ev.VoiceForceDisconnect, { channelId }, { users: [identity] });
    await removeParticipant(roomName(channelId), identity);
    await markLeft(identity, channelId);
    return;
  }
  await markJoined(identity, channelId);
  const state = await getState(identity);
  if (state?.serverId && state.channelId === channelId) await syncVoicePermissions(state.serverId, [identity]);
}

export async function handleWebhook(ev: WebhookEvent): Promise<void> {
  const room = ev.room?.name;
  const channelId = room ? channelFromRoom(room) : null;
  if (!channelId) return;
  const identity = ev.participant?.identity;
  switch (ev.event) {
    case 'participant_joined':
      if (identity) await acceptParticipant(identity,channelId);
      break;
    case 'participant_left':
      if (identity) await markLeft(identity, channelId);
      break;
    case 'room_finished': {
      const members = await redis.smembers(roomKey(channelId));
      for (const m of members) await markLeft(m, channelId);
      await execute(`UPDATE voice_sessions SET ended_at = now() WHERE room_name = $1 AND ended_at IS NULL`, [room]);
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

async function recordLeave(userId: string, channelId: string,db:Queryable): Promise<void> {
  const room = roomName(channelId);
  await execute(
    `UPDATE voice_participants SET left_at = now()
      WHERE user_id = $1 AND left_at IS NULL AND session_id IN (SELECT id FROM voice_sessions WHERE room_name = $2 AND ended_at IS NULL)`,
    [userId, room],
    db,
  );
  const remaining = await redis.scard(roomKey(channelId));
  if (remaining === 0) await execute(`UPDATE voice_sessions SET ended_at = now() WHERE room_name = $1 AND ended_at IS NULL`, [room],db);
}
