import { redis } from '../redis.js';
import type { ChosenStatus, PresenceStatus } from '../models/dto.js';

/**
 * Presence model (Redis):
 *   presence:conns:<userId>  ZSET  connectionId → last heartbeat (ms)
 *   presence:afk             SET   userIds whose clients reported inactivity
 *   presence:status          HASH  userId → effective status visible to others (absent = offline)
 * Every gateway connection heartbeats; a sweeper drops connections of crashed nodes.
 */
const CONN_TTL_MS = 75_000;
const connsKey = (userId: string): string => `presence:conns:${userId}`;
const STATUS_KEY = 'presence:status';
const AFK_KEY = 'presence:afk';

export function effectiveStatus(chosen: ChosenStatus, online: boolean, afk: boolean): PresenceStatus {
  if (!online || chosen === 'invisible') return 'offline';
  if (chosen === 'online' && afk) return 'idle';
  return chosen;
}

export async function getStatuses(userIds: string[]): Promise<Map<string, PresenceStatus>> {
  const out = new Map<string, PresenceStatus>();
  if (userIds.length === 0) return out;
  const unique = [...new Set(userIds)];
  const values = await redis.hmget(STATUS_KEY, ...unique);
  unique.forEach((id, i) => out.set(id, (values[i] as PresenceStatus | null) ?? 'offline'));
  return out;
}

export async function touchConnection(userId: string, connId: string): Promise<void> {
  await redis.zadd(connsKey(userId), Date.now(), connId);
  await redis.pexpire(connsKey(userId), CONN_TTL_MS * 2);
}

export async function dropConnection(userId: string, connId: string): Promise<void> {
  await redis.zrem(connsKey(userId), connId);
}

export async function setAfk(userId: string, afk: boolean): Promise<void> {
  if (afk) await redis.sadd(AFK_KEY, userId);
  else await redis.srem(AFK_KEY, userId);
}

/** Recomputes the effective status. Returns the new status if it changed, otherwise null. */
export async function recompute(userId: string, chosen: ChosenStatus): Promise<PresenceStatus | null> {
  await redis.zremrangebyscore(connsKey(userId), 0, Date.now() - CONN_TTL_MS);
  const [count, afk, prev] = await Promise.all([
    redis.zcard(connsKey(userId)),
    redis.sismember(AFK_KEY, userId),
    redis.hget(STATUS_KEY, userId),
  ]);
  const next = effectiveStatus(chosen, count > 0, afk === 1);
  if (next === 'offline') await redis.hdel(STATUS_KEY, userId);
  else await redis.hset(STATUS_KEY, userId, next);
  if (count === 0) await redis.srem(AFK_KEY, userId);
  const previous = (prev as PresenceStatus | null) ?? 'offline';
  return previous === next ? null : next;
}

/** Users that currently appear online (used by the stale-connection sweeper). */
export async function onlineUserIds(): Promise<string[]> {
  return redis.hkeys(STATUS_KEY);
}
