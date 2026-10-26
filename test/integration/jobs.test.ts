import { PgBoss } from 'pg-boss';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { transaction } from '../../src/db/client.js';
import { JOBS, PgBossQueue, ensureQueues } from '../../src/jobs/queue.js';
import { type Harness, sh, startHarness } from './harness.js';

let h: Harness;
let boss: PgBoss;
beforeAll(async () => {
  h = await startHarness();
  boss = new PgBoss({ connectionString: h.container.getConnectionUri(), supervise: false, schedule: false });
  await boss.start();
  await ensureQueues(boss);
  h.deps.queue = new PgBossQueue(boss);
});
afterAll(async () => {
  await boss?.stop({ graceful: false });
  await h?.stop();
});

describe('pg-boss jobs', () => {
  it('a start enqueues events.auto_finish at E + 5 in the same transaction', async () => {
    const { token } = await h.signIn();
    const ev = (await h.request('POST', '/v1/events', { token, body: { title: 'x', planned_start: sh('14:00'), duration_slots: 3 } })).body;
    h.clock.set(sh('14:00'));
    expect((await h.request('POST', `/v1/events/${ev.id}/start`, { token, body: { tapped_at: sh('14:00') } })).status).toBe(200);
    const jobs = await boss.findJobs<{ event_id: string }>(JOBS.autoFinish, { data: { event_id: ev.id } });
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.startAfter.toISOString()).toBe(new Date(sh('15:05')).toISOString());
  });

  it('no job survives a rolled-back transaction', async () => {
    const marker = `rollback-${Date.now()}`;
    await expect(
      transaction(h.database, async (tx) => {
        await h.deps.queue.send(JOBS.autoFinish, { event_id: marker, expected_end: new Date().toISOString() }, { tx });
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    const { rows } = await h.database.pool.query(`SELECT count(*)::int AS n FROM pgboss.job WHERE data->>'event_id' = $1`, [marker]);
    expect(rows[0].n).toBe(0);
  });
});
