/** Integration tests truncate SQL tables and flush Redis: validate actual database names. */
export function assertTestDatabases(env: Record<string, string | undefined>): void {
  if (env.NODE_ENV !== 'test') throw new Error('API tests require NODE_ENV=test');
  let database: string, redisDb: number;
  try {
    database = decodeURIComponent(new URL(env.DATABASE_URL ?? '').pathname.slice(1));
    redisDb = Number(new URL(env.REDIS_URL ?? '').pathname.slice(1));
  } catch { throw new Error('API tests require explicit PostgreSQL and Redis URLs'); }
  if (!/(^test($|_)|_test($|_))/i.test(database)) throw new Error('Refusing destructive tests: PostgreSQL database name must contain a test segment');
  if (!Number.isInteger(redisDb) || redisDb < 1) throw new Error('Refusing destructive tests: choose a dedicated nonzero Redis database');
}
