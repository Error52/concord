import { config,validateMailConfiguration } from './config.js';
import { log } from './logger.js';
import { migrate } from './db/migrate.js';
import { pool } from './db/pool.js';
import { closeRedis } from './redis.js';
import { storage } from './storage/index.js';
import { createApp } from './app.js';
import { startJobs } from './jobs.js';
import { seed } from './db/seed.js';
import { syncPlatformAdmins } from './services/adminService.js';
import {protectQueuedMail,clearInvalidMail} from './services/mailOutbox.js';

async function main(): Promise<void> {
  validateMailConfiguration();
  await migrate();
  await protectQueuedMail();
  await clearInvalidMail();
  await storage.ensureBucket();
  if (process.env.SEED_ON_START === '1') await seed();
  await syncPlatformAdmins();
  const { server, gateway } = createApp();
  await gateway.start();
  const stopJobs = startJobs();

  server.listen(config.PORT, process.env.HOST ?? '0.0.0.0', () => log.info('backend listening', { port: config.PORT, env: config.NODE_ENV }));

  let closing = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (closing) return;
    closing = true;
    log.info('shutting down', { signal });
    stopJobs();
    await gateway.stop();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await pool.end();
    await closeRedis();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((err: unknown) => {
  log.error('fatal startup error', { err });
  process.exit(1);
});
