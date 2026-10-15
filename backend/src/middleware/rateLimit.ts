import { redis } from '../redis.js';
import { Errors } from '../http/errors.js';

export interface RateLimitRule {
  /** Bucket name, e.g. "login". */
  name: string;
  max: number;
  windowSec: number;
  by?: 'ip' | 'user';
}

/**
 * Fixed-window limiter in Redis. Atomic INCR + EXPIRE (set only on first hit).
 * Throws 429 with Retry-After when exceeded.
 */
export async function rateLimit(rule: RateLimitRule, subject: string): Promise<void> {
  const key = `rl:${rule.name}:${subject}`;
  const results = await redis.multi().incr(key).ttl(key).exec();
  const count = Number(results?.[0]?.[1] ?? 0);
  let ttl = Number(results?.[1]?.[1] ?? -1);
  if (ttl < 0) {
    await redis.expire(key, rule.windowSec);
    ttl = rule.windowSec;
  }
  if (count > rule.max) throw Errors.rateLimited(ttl);
}
