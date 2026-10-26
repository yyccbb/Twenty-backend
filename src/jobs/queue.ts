import type { PgBoss } from 'pg-boss';
import type { Tx } from '../db/client.js';

export const JOBS = {
  aiBreakdown: 'ai.breakdown',
  autoFinish: 'events.auto_finish',
  closeStale: 'events.close_stale',
  backup: 'db.backup',
  purge: 'maintenance.purge',
} as const;

export type JobName = (typeof JOBS)[keyof typeof JOBS];

export const BREAKDOWN_RETRIES = 2;

const QUEUE_OPTIONS: Record<JobName, Parameters<PgBoss['createQueue']>[1]> = {
  [JOBS.aiBreakdown]: { retryLimit: BREAKDOWN_RETRIES, retryDelay: 20, retryBackoff: true, expireInSeconds: 300 },
  [JOBS.autoFinish]: { retryLimit: 5, retryDelay: 30 },
  [JOBS.closeStale]: { retryLimit: 0 },
  [JOBS.backup]: { retryLimit: 2, retryDelay: 600, expireInSeconds: 3600 },
  [JOBS.purge]: { retryLimit: 0 },
};

/** Creates every queue (a no-op if it exists) and syncs its options. Both the API and the worker call this at boot. */
export async function ensureQueues(boss: PgBoss): Promise<void> {
  for (const [name, options] of Object.entries(QUEUE_OPTIONS)) {
    await boss.createQueue(name, options);
    await boss.updateQueue(name, options);
  }
}

export interface AutoFinishJob {
  event_id: string;
  /** The planned end E this job was scheduled for; the job is a no-op if E has changed since. */
  expected_end: string;
}

export interface BreakdownJob {
  breakdown_id: string;
}

export interface SendOptions {
  startAfter?: Date;
  /** Enqueue inside this transaction so the job exists only if the transaction commits. */
  tx?: Tx;
}

export interface JobQueue {
  send(name: JobName, data: object, options?: SendOptions): Promise<string | null>;
}

export class PgBossQueue implements JobQueue {
  constructor(private readonly boss: PgBoss) {}

  send(name: JobName, data: object, options: SendOptions = {}): Promise<string | null> {
    return this.boss.send(name, data, {
      ...(options.startAfter ? { startAfter: options.startAfter } : {}),
      ...(options.tx ? { db: { executeSql: options.tx.executeSql } } : {}),
    });
  }
}

/** Test double: records jobs instead of running them. */
export class RecordingQueue implements JobQueue {
  readonly sent: Array<{ name: JobName; data: any; startAfter?: Date }> = [];

  async send(name: JobName, data: object, options: SendOptions = {}): Promise<string | null> {
    this.sent.push({ name, data, startAfter: options.startAfter });
    return `job-${this.sent.length}`;
  }

  take(name: JobName) {
    const matching = this.sent.filter((j) => j.name === name);
    this.sent.splice(0, this.sent.length, ...this.sent.filter((j) => j.name !== name));
    return matching;
  }
}
