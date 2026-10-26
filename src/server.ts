import { serve } from '@hono/node-server';
import { PgBoss } from 'pg-boss';
import { createApp } from './app.js';
import { buildDeps } from './bootstrap.js';
import { loadConfig } from './config.js';
import { PgBossQueue, ensureQueues } from './jobs/queue.js';
import { logger } from './lib/logger.js';

const config = loadConfig();
// The API only enqueues jobs; the worker process runs them, schedules cron and does queue maintenance.
const boss = new PgBoss({ connectionString: config.DATABASE_URL, supervise: false, schedule: false, max: 2 });
boss.on('error', (err) => logger.error({ err }, 'pg-boss error'));
await boss.start();
await ensureQueues(boss);

const deps = buildDeps(new PgBossQueue(boss), config);
const app = createApp(deps);
const server = serve({ fetch: app.fetch, port: config.PORT }, (info) => logger.info({ port: info.port }, 'api listening'));

async function shutdown(signal: string) {
  logger.info({ signal }, 'shutting down');
  server.close();
  await boss.stop({ graceful: true, timeout: 10_000 });
  await deps.database.close();
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
