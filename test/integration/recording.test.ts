import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { handleAutoFinish, handleCloseStale } from '../../src/jobs/handlers.js';
import { CLOCK_START, type Harness, sh, startHarness } from './harness.js';

let h: Harness;
beforeAll(async () => {
  h = await startHarness();
});
beforeEach(() => h.clock.set(CLOCK_START));
afterAll(async () => h?.stop());

async function createEvent(token: string, start: string, bars: number, title = 'Block', kind: 'cadenza' | 'tutti' = 'cadenza') {
  const res = await h.request('POST', '/v1/events', { token, body: { title, planned_start: start, duration_bars: bars, kind } });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body;
}

/** Sets the server clock to the tap time and posts the tap. */
async function tap(token: string, id: string, action: 'start' | 'finish', time: string, headers?: Record<string, string>) {
  h.clock.set(time);
  return h.request('POST', `/v1/events/${id}/${action}`, { token, body: { tapped_at: time }, headers });
}

async function balance(token: string) {
  return (await h.request('GET', '/v1/me', { token })).body.token_balance;
}

describe('start and finish', () => {
  it('on time start and finish earns the full reward', async () => {
    const { token } = await h.signIn();
    const ev = await createEvent(token, sh('14:00'), 3);
    const start = await tap(token, ev.id, 'start', sh('14:03:10'));
    expect(start.status).toBe(200);
    expect(start.body).toMatchObject({ outcome: 'on_time', early_bars: 0, late_bars: 0 });
    expect(new Date(start.body.recorded_start).toISOString()).toBe(new Date(sh('14:00')).toISOString());

    const job = h.queue.take('events.auto_finish').find((j) => j.data.event_id === ev.id)!;
    expect(job.startAfter!.toISOString()).toBe(new Date(sh('15:05')).toISOString());

    const finish = await tap(token, ev.id, 'finish', sh('14:58'));
    expect(finish.status).toBe(200);
    expect(finish.body).toMatchObject({ finish_kind: 'on_time', tokens_awarded: 30, token_balance: 30 });
    expect(finish.body.event.status).toBe('done');
    expect(await balance(token)).toBe(30);
  });

  it('late start loses only the missed bar; early start earns 50% per early bar', async () => {
    const { token } = await h.signIn();
    const late = await createEvent(token, sh('14:00'), 3);
    expect((await tap(token, late.id, 'start', sh('14:07:12'))).body).toMatchObject({ outcome: 'late', late_bars: 1 });
    expect((await tap(token, late.id, 'finish', sh('15:00'))).body.tokens_awarded).toBe(20);

    const early = await createEvent(token, sh('16:00'), 3);
    const s = await tap(token, early.id, 'start', sh('15:30'));
    expect(s.body).toMatchObject({ outcome: 'early', early_bars: 1 });
    expect((await tap(token, early.id, 'finish', sh('17:00'))).body.tokens_awarded).toBe(35);
    expect(await balance(token)).toBe(55);
  });

  it('rejects a start more than 2 bars early, and an early start that would overlap another Cadenza', async () => {
    const { token } = await h.signIn();
    const a = await createEvent(token, sh('13:00'), 2, 'A');
    await createEvent(token, sh('13:20'), 2, 'B', 'tutti');
    const x = await createEvent(token, sh('14:00'), 3, 'X');

    const tooEarly = await tap(token, x.id, 'start', sh('13:05'));
    expect(tooEarly.status).toBe(422);
    expect(tooEarly.body.error.code).toBe('too_early');

    const overlap = await tap(token, x.id, 'start', sh('13:25'));
    expect(overlap.status).toBe(409);
    expect(overlap.body.error).toMatchObject({ code: 'cadenza_overlap', conflicts: [a.id] });
    // Touching the Cadenza and overlapping only the Tutti is fine.
    expect((await tap(token, x.id, 'start', sh('13:45'))).body).toMatchObject({ outcome: 'early', early_bars: 1 });
  });

  it('a start that snaps to the planned end marks the event missed', async () => {
    const { token } = await h.signIn();
    const ev = await createEvent(token, sh('14:00'), 1);
    const res = await tap(token, ev.id, 'start', sh('14:05:01'));
    expect(res.body).toMatchObject({ outcome: 'missed', recorded_start: null });
    expect(res.body.event.status).toBe('missed');
  });

  it('shortened and abandoned finishes', async () => {
    const { token } = await h.signIn();
    const a = await createEvent(token, sh('14:00'), 3);
    const b = await createEvent(token, sh('16:00'), 3);
    const c = await createEvent(token, sh('18:00'), 3);
    await tap(token, a.id, 'start', sh('14:00'));
    // Finishing 10 minutes early loses the last bar: on time is only (E − 5, E + 5].
    const short = await tap(token, a.id, 'finish', sh('14:50'));
    expect(short.body).toMatchObject({ finish_kind: 'shortened', tokens_awarded: 20 });
    expect(short.body.recorded_end).toBe(new Date(sh('14:40')).toISOString());

    await tap(token, b.id, 'start', sh('16:00'));
    const abandoned = await tap(token, b.id, 'finish', sh('16:04'));
    expect(abandoned.body).toMatchObject({ finish_kind: 'abandoned', recorded_end: null, tokens_awarded: 0 });

    // Away from the end, finish taps snap like start taps: 18:30 snaps to 18:40.
    await tap(token, c.id, 'start', sh('18:00'));
    expect((await tap(token, c.id, 'finish', sh('18:30'))).body).toMatchObject({ finish_kind: 'shortened', tokens_awarded: 20 });
  });

  it('starts only one Cadenza at a time', async () => {
    const { token } = await h.signIn();
    const a = await createEvent(token, sh('14:00'), 3, 'A');
    const b = await createEvent(token, sh('15:00'), 3, 'B');
    await tap(token, a.id, 'start', sh('14:00'));

    const blocked = await tap(token, b.id, 'start', sh('14:58'));
    expect(blocked.status).toBe(409);
    expect(blocked.body.error).toMatchObject({ code: 'cadenza_in_progress', conflicts: [a.id] });

    // "Finish A and start B": the same tap time for both, A's finish first.
    expect((await tap(token, a.id, 'finish', sh('14:58'))).body.finish_kind).toBe('on_time');
    expect((await tap(token, b.id, 'start', sh('14:58'))).body).toMatchObject({ outcome: 'on_time', late_bars: 0 });
  });

  it('a Cadenza past E + 5 is auto-finished before its job runs, so it no longer blocks a start', async () => {
    const { token } = await h.signIn();
    const a = await createEvent(token, sh('14:00'), 3, 'A');
    const b = await createEvent(token, sh('15:00'), 3, 'B');
    await tap(token, a.id, 'start', sh('14:00'));
    const job = h.queue.take('events.auto_finish').find((j) => j.data.event_id === a.id)!;

    const start = await tap(token, b.id, 'start', sh('15:05:01'));
    expect(start.body).toMatchObject({ outcome: 'late', late_bars: 1 });
    expect((await h.request('GET', `/v1/events/${a.id}`, { token })).body).toMatchObject({
      status: 'done',
      record: { finish_kind: 'auto', tokens_awarded: 20 },
    });
    expect(await handleAutoFinish(h.deps, job.data)).toBe(false);

    // A's queued offline finish from before E + 5 still replaces the auto-finish.
    h.clock.set(sh('15:10'));
    const late = await h.request('POST', `/v1/events/${a.id}/finish`, { token, body: { tapped_at: sh('15:04') } });
    expect(late.body).toMatchObject({ finish_kind: 'on_time', tokens_awarded: 30, token_balance: 30 });
  });

  it('rejects a finish tap made after E + 5', async () => {
    const { token } = await h.signIn();
    const ev = await createEvent(token, sh('14:00'), 3);
    await tap(token, ev.id, 'start', sh('14:00'));
    const job = h.queue.take('events.auto_finish').find((j) => j.data.event_id === ev.id)!;

    const late = await tap(token, ev.id, 'finish', sh('15:05:01'));
    expect(late.status).toBe(409);
    expect(late.body.error.code).toBe('window_closed');
    expect(await handleAutoFinish(h.deps, job.data)).toBe(true);

    // Once auto-finished, a tap after E + 5 still can't replace it.
    h.clock.set(sh('15:30'));
    const replay = await h.request('POST', `/v1/events/${ev.id}/finish`, { token, body: { tapped_at: sh('15:06') } });
    expect(replay.body.error.code).toBe('window_closed');
    expect(await balance(token)).toBe(20);
  });

  it('rejects taps from a clock that is far off', async () => {
    const { token } = await h.signIn();
    const ev = await createEvent(token, sh('14:00'), 3);
    h.clock.set(sh('14:00'));
    const future = await h.request('POST', `/v1/events/${ev.id}/start`, { token, body: { tapped_at: sh('14:10') } });
    expect(future.body.error.code).toBe('tap_in_future');
    const old = await h.request('POST', `/v1/events/${ev.id}/start`, { token, body: { tapped_at: sh('13:00', '2026-10-31') } });
    expect(old.body.error.code).toBe('tap_too_old');
  });

  it('Tuttis are never started, extended or finished', async () => {
    const { token } = await h.signIn();
    const t = await createEvent(token, sh('14:00'), 3, 'T', 'tutti');
    for (const action of ['start', 'finish'] as const) {
      const res = await tap(token, t.id, action, sh('14:00'));
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('not_cadenza');
    }
    const ext = await h.request('POST', `/v1/events/${t.id}/extend`, { token, body: { bars: 1 } });
    expect(ext.body.error.code).toBe('not_cadenza');
    expect(await balance(token)).toBe(0);
  });
});

describe('idempotency', () => {
  it('a retried finish with the same Idempotency-Key replays the response and pays once', async () => {
    const { token } = await h.signIn();
    const ev = await createEvent(token, sh('14:00'), 3);
    await tap(token, ev.id, 'start', sh('14:00'));
    const first = await tap(token, ev.id, 'finish', sh('15:00'), { 'idempotency-key': 'fin-1' });
    const retry = await tap(token, ev.id, 'finish', sh('15:00'), { 'idempotency-key': 'fin-1' });
    expect(retry.status).toBe(200);
    expect(retry.headers.get('idempotent-replayed')).toBe('true');
    expect(retry.body).toEqual(first.body);
    expect(await balance(token)).toBe(30);

    const reused = await tap(token, ev.id, 'finish', sh('14:59'), { 'idempotency-key': 'fin-1' });
    expect(reused.status).toBe(422);
    expect(reused.body.error.code).toBe('idempotency_key_reused');
  });

  it('a retry without a key cannot pay twice either', async () => {
    const { token } = await h.signIn();
    const ev = await createEvent(token, sh('14:00'), 3);
    await tap(token, ev.id, 'start', sh('14:00'));
    await tap(token, ev.id, 'finish', sh('15:00'));
    const again = await tap(token, ev.id, 'finish', sh('15:00'));
    expect(again.status).toBe(409);
    expect(await balance(token)).toBe(30);
  });
});

describe('auto-finish and stale events', () => {
  it('the auto-finish job deducts one bar; a stale job after an extension is a no-op', async () => {
    const { token } = await h.signIn();
    const ev = await createEvent(token, sh('14:00'), 3);
    await tap(token, ev.id, 'start', sh('14:00'));
    const firstJob = h.queue.take('events.auto_finish').find((j) => j.data.event_id === ev.id)!;

    h.clock.set(sh('14:50'));
    const ext = await h.request('POST', `/v1/events/${ev.id}/extend`, { token, body: { bars: 1 } });
    expect(ext.status).toBe(200);
    const secondJob = h.queue.take('events.auto_finish').find((j) => j.data.event_id === ev.id)!;
    expect(secondJob.startAfter!.toISOString()).toBe(new Date(sh('15:25')).toISOString());

    h.clock.set(sh('15:05'));
    expect(await handleAutoFinish(h.deps, firstJob.data)).toBe(false);
    h.clock.set(sh('15:25'));
    expect(await handleAutoFinish(h.deps, secondJob.data)).toBe(true);

    const got = await h.request('GET', `/v1/events/${ev.id}`, { token });
    expect(got.body.record).toMatchObject({ finish_kind: 'auto', tokens_awarded: 25, extended_bars: 1 });
    expect(await balance(token)).toBe(25);
  });

  it('a queued offline finish tap from before E+5 corrects an auto-finish with a new ledger entry', async () => {
    const { token } = await h.signIn();
    const ev = await createEvent(token, sh('14:00'), 3);
    await tap(token, ev.id, 'start', sh('14:00'));
    const job = h.queue.take('events.auto_finish').find((j) => j.data.event_id === ev.id)!;
    h.clock.set(sh('15:05'));
    await handleAutoFinish(h.deps, job.data);
    expect(await balance(token)).toBe(20);

    h.clock.set(sh('15:30'));
    const late = await h.request('POST', `/v1/events/${ev.id}/finish`, { token, body: { tapped_at: sh('15:01') } });
    expect(late.status).toBe(200);
    expect(late.body).toMatchObject({ finish_kind: 'on_time', tokens_awarded: 30, token_balance: 30 });
    const ledger = await h.request('GET', '/v1/tokens/ledger', { token });
    expect(ledger.body.entries.map((e: any) => [e.reason, e.delta])).toEqual([
      ['adjustment', 10],
      ['event_reward', 20],
    ]);
    // A second late tap can't correct again.
    expect((await h.request('POST', `/v1/events/${ev.id}/finish`, { token, body: { tapped_at: sh('15:02') } })).status).toBe(409);
  });

  it('close_stale leaves Tuttis alone', async () => {
    const { token } = await h.signIn();
    const t = await createEvent(token, sh('09:00', '2026-11-04'), 1, 'T', 'tutti');
    h.clock.set(sh('10:01', '2026-11-04'));
    await handleCloseStale(h.deps);
    expect((await h.request('GET', `/v1/events/${t.id}`, { token })).body.status).toBe('planned');
  });

  it('close_stale marks unstarted past events missed, but a queued offline start still counts', async () => {
    const { token } = await h.signIn();
    const ev = await createEvent(token, sh('09:00', '2026-11-03'), 3);
    h.clock.set(sh('10:01', '2026-11-03'));
    const result = await handleCloseStale(h.deps);
    expect(result.missed).toBeGreaterThanOrEqual(1);
    expect((await h.request('GET', `/v1/events/${ev.id}`, { token })).body.status).toBe('missed');

    const offline = await h.request('POST', `/v1/events/${ev.id}/start`, { token, body: { tapped_at: sh('09:02', '2026-11-03') } });
    expect(offline.status).toBe(200);
    expect(offline.body.outcome).toBe('on_time');
  });
});

describe('extend', () => {
  it('pushes later events in a cascade and returns every moved event; dry_run saves nothing', async () => {
    const { token } = await h.signIn();
    const a = await createEvent(token, sh('14:00'), 3, 'A');
    const b = await createEvent(token, sh('15:00'), 2, 'B');
    const c = await createEvent(token, sh('15:40'), 2, 'C');
    await tap(token, a.id, 'start', sh('14:00'));
    h.clock.set(sh('14:30'));

    const preview = await h.request('POST', `/v1/events/${a.id}/extend`, { token, body: { bars: 1, dry_run: true } });
    expect(preview.status).toBe(200);
    expect(preview.body.moved.map((m: any) => m.id)).toEqual([b.id, c.id]);
    expect((await h.request('GET', `/v1/events/${b.id}`, { token })).body.planned_start).toBe(new Date(sh('15:00')).toISOString());

    const res = await h.request('POST', `/v1/events/${a.id}/extend`, { token, body: { bars: 1 } });
    expect(res.body.new_end).toBe(new Date(sh('15:20')).toISOString());
    expect(res.body.moved).toEqual([
      { id: b.id, planned_start: new Date(sh('15:20')).toISOString(), planned_end: new Date(sh('16:00')).toISOString(), version: 2 },
      { id: c.id, planned_start: new Date(sh('16:00')).toISOString(), planned_end: new Date(sh('16:40')).toISOString(), version: 2 },
    ]);
    expect((await h.request('GET', `/v1/events/${c.id}`, { token })).body.planned_start).toBe(new Date(sh('16:00')).toISOString());

    // Extended bars earn 50%.
    expect((await tap(token, a.id, 'finish', sh('15:20'))).body.tokens_awarded).toBe(35);
  });

  it('moves each Cadenza only as far as needed and never moves Tuttis', async () => {
    const { token } = await h.signIn();
    const a = await createEvent(token, sh('14:00'), 3, 'A');
    const b = await createEvent(token, sh('15:20'), 2, 'B');
    const c = await createEvent(token, sh('16:20'), 1, 'C');
    const d = await createEvent(token, sh('17:20'), 1, 'D');
    const t = await createEvent(token, sh('15:00'), 2, 'T', 'tutti');
    await tap(token, a.id, 'start', sh('14:00'));
    h.clock.set(sh('14:30'));

    const res = await h.request('POST', `/v1/events/${a.id}/extend`, { token, body: { bars: 3 } });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.moved.map((m: any) => [m.id, m.planned_start])).toEqual([
      [b.id, new Date(sh('16:00')).toISOString()],
      [c.id, new Date(sh('16:40')).toISOString()],
    ]);
    for (const [id, start] of [[d.id, '17:20'], [t.id, '15:00']] as const) {
      expect((await h.request('GET', `/v1/events/${id}`, { token })).body.planned_start).toBe(new Date(sh(start)).toISOString());
    }
    const shifts = await h.database.pool.query(
      `SELECT event_id, delta_bars FROM event_changes WHERE kind = 'cascade_shift' AND caused_by_event_id = $1 ORDER BY delta_bars DESC`,
      [a.id],
    );
    expect(shifts.rows).toEqual([
      { event_id: b.id, delta_bars: 2 },
      { event_id: c.id, delta_bars: 1 },
    ]);
  });

  it('extends only a Cadenza in progress, by 1 to 72 bars', async () => {
    const { token } = await h.signIn();
    const a = await createEvent(token, sh('14:00'), 3, 'A');
    const extend = (bars: number) => h.request('POST', `/v1/events/${a.id}/extend`, { token, body: { bars } });
    expect((await extend(1)).body.error.code).toBe('invalid_state');
    await tap(token, a.id, 'start', sh('14:00'));
    expect((await extend(73)).body.error.code).toBe('invalid_bars');
    expect((await extend(72)).status).toBe(200);
  });

  it('never pushes a Cadenza that already ran, even when a late offline start makes the cascade reach one', async () => {
    const { token } = await h.signIn();
    const a = await createEvent(token, sh('14:00'), 3, 'A');
    const x = await createEvent(token, sh('15:00'), 2, 'X');
    // X runs on one device while A's start, tapped at 14:00 on another, is still queued offline.
    await tap(token, x.id, 'start', sh('15:00'));
    h.clock.set(sh('15:03:30'));
    const finish = await h.request('POST', `/v1/events/${x.id}/finish`, { token, body: { tapped_at: sh('15:05:30') } });
    expect(finish.body.recorded_end).toBe(new Date(sh('15:20')).toISOString());
    h.clock.set(sh('15:04'));
    expect((await h.request('POST', `/v1/events/${a.id}/start`, { token, body: { tapped_at: sh('14:00') } })).status).toBe(200);

    const res = await h.request('POST', `/v1/events/${a.id}/extend`, { token, body: { bars: 1 } });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatchObject({ code: 'pushed_event_locked', conflicts: [x.id] });
  });

  it('warns about pushes past the day end and closes 5 minutes after the end', async () => {
    const { token } = await h.signIn();
    const a = await createEvent(token, sh('22:00'), 3, 'A');
    const b = await createEvent(token, sh('23:00'), 2, 'B');
    await tap(token, a.id, 'start', sh('22:00'));
    h.clock.set(sh('22:30'));
    const res = await h.request('POST', `/v1/events/${a.id}/extend`, { token, body: { bars: 2, dry_run: true } });
    expect(res.body.day_end_warnings).toEqual([b.id]);

    await h.request('PATCH', '/v1/me/settings', { token, body: { day_end_local_time: '02:00' } });
    const later = await h.request('POST', `/v1/events/${a.id}/extend`, { token, body: { bars: 2, dry_run: true } });
    expect(later.body.day_end_warnings).toEqual([]);

    h.clock.set(sh('23:05:01'));
    const closed = await h.request('POST', `/v1/events/${a.id}/extend`, { token, body: { bars: 1 } });
    expect(closed.body.error.code).toBe('window_closed');
  });
});
