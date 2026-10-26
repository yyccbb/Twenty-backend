import { spawn } from 'node:child_process';
import { lt } from 'drizzle-orm';
import { idempotencyKeys } from '../db/schema.js';
import type { Deps } from '../deps.js';
import { logger } from '../lib/logger.js';
import { addDays } from '../lib/time.js';
import { closeStaleEvents, autoFinishEvent } from '../services/recording.js';
import { runBreakdownJob } from '../services/breakdowns.js';
import type { AutoFinishJob, BreakdownJob } from './queue.js';

export const handleAutoFinish = (deps: Deps, data: AutoFinishJob) => autoFinishEvent(deps, data.event_id, new Date(data.expected_end));

export const handleCloseStale = (deps: Deps) => closeStaleEvents(deps);

export const handleBreakdown = (deps: Deps, data: BreakdownJob, opts: { finalAttempt: boolean; signal?: AbortSignal }) =>
  runBreakdownJob(deps, data.breakdown_id, opts);

/** Idempotency-Key replay records are kept for 24 hours. */
export async function handlePurge(deps: Deps) {
  const removed = await deps.database.db
    .delete(idempotencyKeys)
    .where(lt(idempotencyKeys.createdAt, addDays(deps.clock.now(), -1)))
    .returning({ key: idempotencyKeys.key });
  logger.info({ removed: removed.length }, 'purged idempotency keys');
}

/** Nightly pg_dump (custom format) streamed straight to Alibaba Cloud OSS. */
export async function handleBackup(deps: Deps) {
  const c = deps.config;
  if (!c.OSS_REGION || !c.OSS_BUCKET || !c.OSS_ACCESS_KEY_ID || !c.OSS_ACCESS_KEY_SECRET) {
    logger.warn('db.backup skipped: OSS is not configured');
    return;
  }
  const { default: OSS } = await import('ali-oss');
  const client = new OSS({
    region: c.OSS_REGION,
    bucket: c.OSS_BUCKET,
    accessKeyId: c.OSS_ACCESS_KEY_ID,
    accessKeySecret: c.OSS_ACCESS_KEY_SECRET,
    secure: true,
  });
  const stamp = deps.clock.now().toISOString().replace(/[:.]/g, '-');
  const name = `${c.OSS_BACKUP_PREFIX}twenty-${stamp}.dump`;

  const dump = spawn('pg_dump', ['--format=custom', '--no-owner', '--dbname', c.DATABASE_URL], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  dump.stderr.on('data', (chunk) => (stderr += chunk));
  const exited = new Promise<number>((resolve, reject) => {
    dump.on('error', reject);
    dump.on('close', (code) => resolve(code ?? 1));
  });
  await client.putStream(name, dump.stdout);
  const code = await exited;
  if (code !== 0) {
    await client.delete(name).catch(() => {});
    throw new Error(`pg_dump exited with ${code}: ${stderr.slice(0, 500)}`);
  }
  logger.info({ object: name }, 'database backup uploaded');
}
