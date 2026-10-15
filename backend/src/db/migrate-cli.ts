import { migrate } from './migrate.js';
import { pool } from './pool.js';

await migrate();
await pool.end();
