import pg from 'pg';
import { config } from '../config.js';
import { log } from '../logger.js';

// bigint columns (message ids) stay strings: they exceed JS safe integers in principle
// and are opaque identifiers on the wire anyway.

export const pool = new pg.Pool({
  connectionString: config.DATABASE_URL,
  max: 20,
  idleTimeoutMillis: 30_000,
});

pool.on('error', (err: Error) => log.error('postgres pool error', { err }));

/** Anything that can run a query: the pool or a checked-out client inside a transaction. */
export interface Queryable {
  query(text: string, params?: unknown[]): Promise<{ rows: unknown[]; rowCount: number | null }>;
}

export async function query<R extends object>(text: string, params: unknown[] = [], db: Queryable = pool): Promise<R[]> {
  const res = await db.query(text, params);
  return res.rows as R[];
}

export async function queryOne<R extends object>(text: string, params: unknown[] = [], db: Queryable = pool): Promise<R | null> {
  const res = await db.query(text, params);
  return (res.rows[0] as R | undefined) ?? null;
}

export async function execute(text: string, params: unknown[] = [], db: Queryable = pool): Promise<number> {
  const res = await db.query(text, params);
  return res.rowCount ?? 0;
}

/** Runs fn inside a transaction; rolls back on any thrown error. */
export async function tx<T>(fn: (db: Queryable) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}
