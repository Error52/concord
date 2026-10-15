import { createHash, timingSafeEqual } from 'node:crypto';
import { config } from '../config.js';
import { signJwt, verifyJwt } from '../auth/jwt.js';
import { log } from '../logger.js';

/**
 * LiveKit integration without the server SDK: access tokens are plain HS256 JWTs with a
 * `video` grant, the RoomService is a Twirp/JSON API, and webhooks are signed JWTs.
 */

export type TrackSourceGrant = 'microphone' | 'camera' | 'screen_share' | 'screen_share_audio';

export interface JoinGrant {
  room: string;
  identity: string;
  name: string;
  metadata: string;
  canPublish: boolean;
  canSubscribe: boolean;
  sources: TrackSourceGrant[];
  ttlSec?: number;
}

export function createJoinToken(g: JoinGrant): string {
  return signJwt(
    {
      iss: config.LIVEKIT_API_KEY,
      sub: g.identity,
      jti: g.identity,
      nbf: Math.floor(Date.now() / 1000) - 5,
      name: g.name,
      metadata: g.metadata,
      video: {
        room: g.room,
        roomJoin: true,
        canPublish: g.canPublish,
        canSubscribe: g.canSubscribe,
        canPublishData: true,
        canPublishSources: g.sources,
        canUpdateOwnMetadata: false,
      },
    },
    config.LIVEKIT_API_SECRET,
    g.ttlSec ?? 6 * 3600,
  );
}

function adminToken(room?: string): string {
  return signJwt(
    { iss: config.LIVEKIT_API_KEY, sub: 'concord-backend', video: { roomAdmin: true, roomList: true, roomCreate: true, ...(room ? { room } : {}) } },
    config.LIVEKIT_API_SECRET,
    60,
  );
}

async function twirp<T>(method: string, body: Record<string, unknown>, room?: string): Promise<T> {
  const url = `${config.LIVEKIT_URL.replace(/\/$/, '')}/twirp/livekit.RoomService/${method}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken(room)}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(5_000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`LiveKit ${method} failed: ${res.status} ${text.slice(0, 200)}`);
  }
  return (await res.json()) as T;
}

export interface LkTrack {
  sid: string;
  source?: string | number;
  type?: string | number;
  muted?: boolean;
}
export interface LkParticipant {
  identity: string;
  tracks?: LkTrack[];
}

export async function listParticipants(room: string): Promise<LkParticipant[]> {
  const res = await twirp<{ participants?: LkParticipant[] }>('ListParticipants', { room }, room);
  return res.participants ?? [];
}

export async function removeParticipant(room: string, identity: string): Promise<void> {
  try {
    await twirp('RemoveParticipant', { room, identity }, room);
  } catch (err) {
    // A participant that already left is not an error for our purposes.
    log.debug('livekit remove participant', { err, room });
  }
}

const ALL_SOURCES: TrackSourceGrant[] = ['microphone', 'camera', 'screen_share', 'screen_share_audio'];
const PROTO_SOURCE: Record<TrackSourceGrant, string> = {
  microphone: 'MICROPHONE',
  camera: 'CAMERA',
  screen_share: 'SCREEN_SHARE',
  screen_share_audio: 'SCREEN_SHARE_AUDIO',
};

/**
 * Applies server-side mute/deafen by changing the participant's permissions. Revoking the
 * microphone source makes the SFU unpublish the mic track, so the client cannot override it.
 */
export function allowedPublishSources(opts:{serverMute:boolean;serverDeaf:boolean;allowVideo:boolean;allowSpeak:boolean}):TrackSourceGrant[] {
  const sources = ALL_SOURCES.filter((s) => {
    if (s === 'microphone') return opts.allowSpeak && !opts.serverMute && !opts.serverDeaf;
    return opts.allowVideo;
  });
  return sources;
}

export async function applyModeration(room: string, identity: string, opts: { serverMute: boolean; serverDeaf: boolean; allowVideo: boolean; allowSpeak:boolean }): Promise<void> {
  const sources=allowedPublishSources(opts);
  await twirp(
    'UpdateParticipant',
    {
      room,
      identity,
      permission: {
        canSubscribe: !opts.serverDeaf,
        canPublish: sources.length>0,
        canPublishData: true,
        canPublishSources: sources.map((s) => PROTO_SOURCE[s]),
      },
    },
    room,
  );
}

export interface WebhookEvent {
  event: string;
  room?: { name: string; sid?: string };
  participant?: { identity: string; sid?: string; name?: string };
  track?: { sid: string; source?: string | number; type?: string | number };
  createdAt?: string | number;
  id?: string;
}

/** Verifies LiveKit's webhook signature: a JWT whose `sha256` claim is the base64 SHA-256 of the body. */
export function verifyWebhook(body: Buffer, authorization: string | undefined): WebhookEvent | null {
  if (!authorization) return null;
  const token = authorization.replace(/^Bearer\s+/i, '');
  const claims = verifyJwt<{ iss?: string; sha256?: string }>(token, config.LIVEKIT_API_SECRET);
  if (!claims || claims.iss !== config.LIVEKIT_API_KEY || !claims.sha256) return null;
  const digest = createHash('sha256').update(body).digest();
  const given = Buffer.from(claims.sha256, 'base64');
  if (given.length !== digest.length || !timingSafeEqual(given, digest)) return null;
  try {
    return JSON.parse(body.toString('utf8')) as WebhookEvent;
  } catch {
    return null;
  }
}
