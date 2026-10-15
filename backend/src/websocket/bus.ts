import { redis } from '../redis.js';
import type { EventName } from './events.js';

/**
 * Cross-instance event bus. Services publish here; every gateway node receives the
 * message via Redis pub/sub and delivers it to its local sockets that match the target.
 */
export const BUS_CHANNEL = 'concord:gateway';

export interface Target {
  /** Deliver to every socket of these users. */
  users?: string[];
  /** Deliver to every socket subscribed to this server (all members). */
  server?: string;
}

export interface Dispatch {
  kind: 'event';
  t: EventName;
  d: unknown;
  target: Target;
  /** Optionally skip one user (e.g. the author of a typing event). */
  exceptUser?: string;
}

export type Control =
  | { kind: 'subscribe'; userId: string; serverId: string }
  | { kind: 'unsubscribe'; userId: string; serverId: string }
  | { kind: 'revoke'; sessionIds: string[] };

export type BusMessage = Dispatch | Control;

export async function emit(t: EventName, d: unknown, target: Target, exceptUser?: string): Promise<void> {
  const msg: Dispatch = { kind: 'event', t, d, target, exceptUser };
  await redis.publish(BUS_CHANNEL, JSON.stringify(msg));
}

export async function control(msg: Control): Promise<void> {
  await redis.publish(BUS_CHANNEL, JSON.stringify(msg));
}
