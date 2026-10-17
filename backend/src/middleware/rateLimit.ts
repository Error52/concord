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
  let count:number,ttl:number;
  try {
    const results = await redis.multi().incr(key).ttl(key).exec();
    if(!results||results.length!==2||results.some(result=>!result||result[0]))throw new Error('Rate limit transaction failed');
    count=Number(results[0]![1]);ttl=Number(results[1]![1]);
    if(!Number.isSafeInteger(count)||count<1||!Number.isInteger(ttl)||ttl< -1)throw new Error('Invalid rate limit state');
    if(ttl<0){
      if(await redis.expire(key,rule.windowSec)!==1)throw new Error('Rate limit expiry failed');
      ttl=rule.windowSec;
    }
  } catch {
    // MULTI may resolve with per-command errors (READONLY/OOM) instead of rejecting.
    throw Errors.unavailable('RATE_LIMIT_UNAVAILABLE','Проверка ограничения запросов недоступна. Повторите позже');
  }
  if(count>rule.max)throw Errors.rateLimited(Math.max(1,ttl));
}
