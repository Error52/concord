import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { pool } from './pool.js';
import { log } from '../logger.js';

/** Locates /migrations whether running from src (tsx) or dist (compiled). */
async function migrationsDir(): Promise<string> {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [process.env.MIGRATIONS_DIR, path.resolve(here, '../migrations'), path.resolve(here, '../../migrations'), path.resolve(here, '../../../migrations')];
  for (const candidate of candidates.filter((c): c is string => !!c)) {
    try {
      await readdir(candidate);
      return candidate;
    } catch {
      /* try next */
    }
  }
  throw new Error('migrations directory not found');
}

/**
 * Applies pending *.sql migrations in lexical order, each in its own transaction.
 * An advisory lock makes concurrent backend replicas safe.
 */
export async function migrate(): Promise<void> {
  const dir = await migrationsDir();
  const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock(727274)');
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
    const done = new Set((await client.query<{ name: string }>('SELECT name FROM schema_migrations')).rows.map((r) => r.name));
    for (const file of files) {
      if (done.has(file)) continue;
      const sql = await readFile(path.join(dir, file), 'utf8');
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
        await client.query('COMMIT');
        log.info('migration applied', { file });
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      }
    }
  } finally {
    await client.query('SELECT pg_advisory_unlock(727274)').catch(() => undefined);
    client.release();
  }
}
