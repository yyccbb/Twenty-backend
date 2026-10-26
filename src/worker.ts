import { randomUUID } from 'node:crypto';
import { PgBoss } from 'pg-boss';
import { buildDeps } from './bootstrap.js';
import { loadConfig } from './config.js';
import { handleAutoFinish, handleBackup, handleBreakdown, handleCloseStale, handlePurge } from './jobs/handlers.js';
import { type AutoFinishJob, BREAKDOWN_RETRIES, type BreakdownJob, JOBS, PgBossQueue, ensureQueues } from './jobs/queue.js';
import { logger, withLogContext } from './lib/logger.js';

const config = loadConfig();
const boss = new PgBoss({ connectionString: config.DATABASE_URL });
boss.on('error', (err) => logger.error({ err }, 'pg-boss error'));
await boss.start();

const deps = buildDeps(new PgBossQueue(boss), config);

await ensureQueues(boss);

/** Runs each job with its job ID as the log request ID. */
function work<T>(name: string, fn: (data: T, job: { retryCount: number; signal: AbortSignal }) => Promise<unknown>) {
  return boss.work<T>(name, async (jobs) => {
    for (const job of jobs) {
      await withLogContext(`job:${job.id}`, async () => {
        logger.info({ job: name }, 'job started');
        await fn(job.data, job);
        logger.info({ job: name }, 'job done');
      });
    }
  });
}

await work<AutoFinishJob>(JOBS.autoFinish, (data) => handleAutoFinish(deps, data));
await work<BreakdownJob>(JOBS.aiBreakdown, (data, job) =>
  handleBreakdown(deps, data, { finalAttempt: job.retryCount >= BREAKDOWN_RETRIES, signal: job.signal }),
);
await work(JOBS.closeStale, () => handleCloseStale(deps));
await work(JOBS.backup, () => handleBackup(deps));
await work(JOBS.purge, () => handlePurge(deps));

await boss.schedule(JOBS.closeStale, '*/20 * * * *');
await boss.schedule(JOBS.purge, '15 * * * *');
if (config.OSS_BUCKET) await boss.schedule(JOBS.backup, config.BACKUP_CRON);
else await boss.unschedule(JOBS.backup).catch(() => {});

logger.info({ instance: randomUUID() }, 'worker started');

async function shutdown(signal: string) {
  logger.info({ signal }, 'worker shutting down');
  await boss.stop({ graceful: true, timeout: 30_000 });
  await deps.database.close();
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
