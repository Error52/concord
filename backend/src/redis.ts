import { Redis } from 'ioredis';
import { config } from './config.js';
import { log } from './logger.js';

function create(name: string): Redis {
  const client = new Redis(config.REDIS_URL, {
    lazyConnect: false,
    maxRetriesPerRequest: 3,
    retryStrategy: (times: number) => Math.min(times * 200, 5_000),
  });
  client.on('error', (err: Error) => log.warn('redis error', { client: name, err }));
  return client;
}

/** Commands (cache, presence, rate limits, publishing). */
export const redis = create('cmd');
/** Dedicated connection: a subscribed Redis connection cannot issue normal commands. */
export const redisSub = create('sub');

export async function closeRedis(): Promise<void> {
  await Promise.allSettled([redis.quit(), redisSub.quit()]);
}
