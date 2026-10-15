import { redis } from '../redis.js';
import { Errors } from '../http/errors.js';
import { requireChannel } from './permissionService.js';
import { loadPublicUser } from '../repositories/userRepo.js';
import { emit } from '../websocket/bus.js';
import { Ev } from '../websocket/events.js';
import { notify } from './notificationService.js';
import { postSystem } from './messageService.js';
import { statesForChannels } from './voiceService.js';

/**
 * DM call signalling. Media goes through the SFU room of the DM channel; this only rings the
 * other participants and tracks whether a ring is outstanding.
 *   call:ring:<channelId>  JSON { callerId, video, startedAt }  (TTL = ring timeout)
 */
const RING_TTL = 45;
const ringKey = (c: string): string => `call:ring:${c}`;

interface Ring {
  callerId: string;
  video: boolean;
  startedAt: string;
}

async function dmPeers(channelId: string, userId: string): Promise<string[]> {
  const ca = await requireChannel(channelId, userId);
  if (ca.channel.type !== 'dm') throw Errors.badRequest('Звонки доступны только в личных сообщениях');
  return ca.dmPeers;
}

export async function ring(channelId: string, userId: string, video: boolean): Promise<void> {
  const peers = await dmPeers(channelId, userId);
  const ring: Ring = { callerId: userId, video, startedAt: new Date().toISOString() };
  await redis.set(ringKey(channelId), JSON.stringify(ring), 'EX', RING_TTL);
  const caller = await loadPublicUser(userId);
  const others = peers.filter((p) => p !== userId);
  await emit(Ev.CallIncoming, { channelId, caller, video, timeoutSec: RING_TTL }, { users: others });
  await notify(others, 'call', { channelId, caller, video });
}

export async function accept(channelId: string, userId: string): Promise<void> {
  const peers = await dmPeers(channelId, userId);
  await redis.del(ringKey(channelId));
  await emit(Ev.CallAccepted, { channelId, userId }, { users: peers });
}

export async function decline(channelId: string, userId: string): Promise<void> {
  const peers = await dmPeers(channelId, userId);
  const raw = await redis.get(ringKey(channelId));
  await redis.del(ringKey(channelId));
  await emit(Ev.CallDeclined, { channelId, userId }, { users: peers });
  if (raw) {
    const r = JSON.parse(raw) as Ring;
    await postSystem(channelId, r.callerId, 'call:missed');
  }
}

/** Ends ringing and, if nobody remains in the room, records the call in the chat. */
export async function end(channelId: string, userId: string, durationSec: number | null): Promise<void> {
  const peers = await dmPeers(channelId, userId);
  const raw = await redis.get(ringKey(channelId));
  await redis.del(ringKey(channelId));
  const remaining = (await statesForChannels([channelId])).filter((s) => s.userId !== userId);
  await emit(Ev.CallEnded, { channelId, userId, remaining: remaining.length }, { users: peers });
  if (remaining.length === 0) {
    if (raw) await postSystem(channelId, userId, 'call:missed');
    else if (durationSec && durationSec > 0) await postSystem(channelId, userId, `call:ended:${Math.round(durationSec)}`);
  }
}

export async function pendingRings(userId: string, channelIds: string[]) {
  const out: { channelId: string; caller: unknown; video: boolean }[] = [];
  for (const channelId of channelIds) {
    const raw = await redis.get(ringKey(channelId));
    if (!raw) continue;
    const r = JSON.parse(raw) as Ring;
    if (r.callerId === userId) continue;
    out.push({ channelId, caller: await loadPublicUser(r.callerId), video: r.video });
  }
  return out;
}
