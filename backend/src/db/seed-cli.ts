import { migrate } from './migrate.js';
import { pool } from './pool.js';
import { closeRedis } from '../redis.js';
import { storage } from '../storage/index.js';
import { seed } from './seed.js';

await migrate();
await storage.ensureBucket();
await seed();
await pool.end();
await closeRedis();
process.exit(0);
