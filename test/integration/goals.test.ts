import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { handleBreakdown } from '../../src/jobs/handlers.js';
import { type Harness, sh, startHarness } from './harness.js';

let h: Harness;
beforeAll(async () => {
  h = await startHarness({ AI_DAILY_BREAKDOWN_LIMIT: '2' });
});
afterAll(async () => h?.stop());

async function goal(token: string) {
  const res = await h.request('POST', '/v1/goals', { token, body: { title: 'Run a half marathon', target_date: '2027-04-01' } });
  expect(res.status).toBe(201);
  return res.body;
}

async function runQueuedBreakdowns(finalAttempt = true) {
  for (const job of h.queue.take('ai.breakdown')) await handleBreakdown(h.deps, job.data, { finalAttempt });
}

describe('goals', () => {
  it('supports CRUD', async () => {
    const { token } = await h.signIn();
    const g = await goal(token);
    expect((await h.request('PATCH', `/v1/goals/${g.id}`, { token, body: { status: 'achieved' } })).body.status).toBe('achieved');
    expect((await h.request('GET', '/v1/goals', { token })).body.items).toHaveLength(1);
    expect((await h.request('DELETE', `/v1/goals/${g.id}`, { token })).status).toBe(204);
    expect((await h.request('GET', `/v1/goals/${g.id}`, { token })).status).toBe(404);
  });

  it("can't be read by another user", async () => {
    const a = await h.signIn();
    const b = await h.signIn();
    const g = await goal(a.token);
    expect((await h.request('GET', `/v1/goals/${g.id}`, { token: b.token })).status).toBe(404);
  });
});

describe('AI breakdown', () => {
  it('queues (202), runs in the worker, and places accepted items on the calendar in one transaction', async () => {
    const { token } = await h.signIn();
    const g = await goal(token);
    const queued = await h.request('POST', `/v1/goals/${g.id}/breakdowns`, { token, body: { hints: 'mornings only' } });
    expect(queued.status).toBe(202);
    expect((await h.request('GET', `/v1/breakdowns/${queued.body.breakdown_id}`, { token })).body.status).toBe('queued');

    await runQueuedBreakdowns();
    const done = await h.request('GET', `/v1/breakdowns/${queued.body.breakdown_id}`, { token });
    expect(done.body).toMatchObject({ status: 'done', model: 'fake-model', prompt_version: 'breakdown-v1' });
    expect(done.body.items.map((i: any) => i.duration_slots)).toEqual([3, 2, 1]);
    expect(h.ai.calls.at(-1)![1]!.content).toContain('mornings only');

    const [first, second] = done.body.items;
    const conflict = await h.request('POST', `/v1/breakdowns/${done.body.id}/accept`, {
      token,
      body: {
        items: [
          { item_id: first.id, planned_start: sh('07:00', '2026-11-03') },
          { item_id: second.id, planned_start: sh('07:00', '2026-11-03') },
          { item_id: second.id, planned_start: sh('07:20', '2026-11-03') },
        ],
      },
    });
    expect(conflict.body.error.code).toBe('overlap_limit');
    const range = `from=${encodeURIComponent(sh('00:00', '2026-11-03'))}&to=${encodeURIComponent(sh('00:00', '2026-11-04'))}`;
    expect((await h.request('GET', `/v1/events?${range}`, { token })).body.items).toHaveLength(0);

    const accepted = await h.request('POST', `/v1/breakdowns/${done.body.id}/accept`, {
      token,
      body: { items: [{ item_id: first.id, planned_start: sh('07:00', '2026-11-03') }, { item_id: second.id, planned_start: sh('08:00', '2026-11-03') }] },
    });
    expect(accepted.status).toBe(201);
    expect(accepted.body.events.map((e: any) => [e.title, e.duration_slots, e.goal_id, e.breakdown_item_id])).toEqual([
      [first.title, 3, g.id, first.id],
      [second.title, 2, g.id, second.id],
    ]);
  });

  it('enforces the per-user daily limit', async () => {
    const { token } = await h.signIn();
    const g = await goal(token);
    for (let i = 0; i < 2; i++) expect((await h.request('POST', `/v1/goals/${g.id}/breakdowns`, { token })).status).toBe(202);
    const third = await h.request('POST', `/v1/goals/${g.id}/breakdowns`, { token });
    expect(third.status).toBe(429);
    expect(third.body.error.code).toBe('daily_limit_reached');
    h.queue.take('ai.breakdown');
  });

  it('fails a breakdown whose model output is unusable, and retries transient errors', async () => {
    const { token } = await h.signIn();
    const g = await goal(token);
    const q1 = await h.request('POST', `/v1/goals/${g.id}/breakdowns`, { token });
    const original = h.deps.ai;
    h.deps.ai = { name: 'broken', completeJson: async () => ({ content: '{"items": [{"title": "x"}]}', model: 'm', tokensUsed: 1 }) };
    await runQueuedBreakdowns();
    const failed = await h.request('GET', `/v1/breakdowns/${q1.body.breakdown_id}`, { token });
    expect(failed.body).toMatchObject({ status: 'failed', error: 'model output has no usable activities' });

    const q2 = await h.request('POST', `/v1/goals/${g.id}/breakdowns`, { token });
    h.deps.ai = { name: 'down', completeJson: async () => { throw new Error('ECONNRESET'); } };
    const [job] = h.queue.take('ai.breakdown');
    await expect(handleBreakdown(h.deps, job!.data, { finalAttempt: false })).rejects.toThrow('ECONNRESET');
    expect((await h.request('GET', `/v1/breakdowns/${q2.body.breakdown_id}`, { token })).body.status).toBe('queued');
    await handleBreakdown(h.deps, job!.data, { finalAttempt: true });
    expect((await h.request('GET', `/v1/breakdowns/${q2.body.breakdown_id}`, { token })).body.status).toBe('failed');
    h.deps.ai = original;
  });
});
