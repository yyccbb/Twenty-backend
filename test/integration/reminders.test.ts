import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Harness, sh, startHarness } from './harness.js';

let h: Harness;
beforeAll(async () => {
  h = await startHarness();
});
afterAll(async () => h?.stop());

const utc = (s: string) => new Date(s).toISOString();

async function calendar(token: string, from: string, to: string) {
  const res = await h.request('GET', `/v1/calendar?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`, { token });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body.reminders as Array<{ reminder_id: string; series_id: string; title: string; original_at: string; at: string; status: string }>;
}

async function daily(token: string, title = 'Stretch', extra: Record<string, unknown> = {}) {
  const res = await h.request('POST', '/v1/reminders', { token, body: { title, at: sh('08:30'), rrule: 'FREQ=DAILY', ...extra } });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body;
}

const week = [sh('00:00'), sh('00:00', '2026-11-09')] as const;

describe('reminders', () => {
  it('validates input', async () => {
    const { token } = await h.signIn();
    const post = (body: object) => h.request('POST', '/v1/reminders', { token, body: { title: 'x', ...body } });
    expect((await post({ at: sh('08:30:30') })).body.error.code).toBe('invalid_time');
    expect((await post({ at: sh('08:31'), rrule: 'BOGUS' })).body.error.code).toBe('invalid_rrule');
    expect((await post({ at: sh('08:31'), rrule: 'FREQ=DAILY;DTSTART=20260101T000000Z' })).body.error.code).toBe('invalid_rrule');
    expect((await post({ at: sh('08:31') })).status).toBe(201);
  });

  it('expands any-minute repeat rules on the server, including RFC 5545 rules like every 2nd Tuesday', async () => {
    const { token } = await h.signIn();
    const r = await daily(token);
    expect(r.series_id).toBe(r.id);
    const occ = await calendar(token, ...week);
    expect(occ.map((o) => o.at)).toEqual(
      ['02', '03', '04', '05', '06', '07', '08'].map((d) => utc(sh('08:30', `2026-11-${d}`))),
    );

    const { token: t2 } = await h.signIn();
    await h.request('POST', '/v1/reminders', { token: t2, body: { title: 'Bills', at: sh('19:07'), rrule: 'RRULE:FREQ=MONTHLY;BYDAY=2TU' } });
    const monthly = await calendar(t2, sh('00:00', '2026-12-01'), sh('00:00', '2027-01-31'));
    expect(monthly.map((o) => o.at)).toEqual([utc(sh('19:07', '2026-12-08')), utc(sh('19:07', '2027-01-12'))]);
  });

  it('keeps wall-clock time across a DST change', async () => {
    const { token } = await h.signIn();
    await h.request('POST', '/v1/reminders', {
      token,
      body: { title: 'NY', at: '2026-10-30T09:00:00-04:00', timezone: 'America/New_York', rrule: 'FREQ=DAILY;COUNT=4' },
    });
    const occ = await calendar(token, '2026-10-29T00:00:00Z', '2026-11-05T00:00:00Z');
    expect(occ.map((o) => o.at)).toEqual([
      '2026-10-30T13:00:00.000Z',
      '2026-10-31T13:00:00.000Z',
      '2026-11-01T14:00:00.000Z',
      '2026-11-02T14:00:00.000Z',
    ]);
  });

  it('records per-occurrence state keyed by the original time', async () => {
    const { token } = await h.signIn();
    const r = await daily(token);
    const put = (day: string, body: object) =>
      h.request('PUT', `/v1/reminders/${r.id}/occurrences/${encodeURIComponent(sh('08:30', `2026-11-${day}`))}`, { token, body });
    expect((await put('03', { status: 'done' })).body.status).toBe('done');
    expect((await put('04', { status: 'moved', new_at: sh('10:15', '2026-11-04') })).body.at).toBe(utc(sh('10:15', '2026-11-04')));
    expect((await put('05', { status: 'snoozed' })).body.error.code).toBe('new_at_required');
    expect((await h.request('PUT', `/v1/reminders/${r.id}/occurrences/${encodeURIComponent(sh('08:31', '2026-11-05'))}`, { token, body: { status: 'done' } })).body.error.code).toBe('invalid_occurrence');

    const occ = await calendar(token, ...week);
    expect(occ.find((o) => o.original_at === utc(sh('08:30', '2026-11-03')))!.status).toBe('done');
    expect(occ.find((o) => o.original_at === utc(sh('08:30', '2026-11-04')))).toMatchObject({ status: 'moved', at: utc(sh('10:15', '2026-11-04')) });

    expect((await put('03', { status: 'pending' })).body.status).toBe('pending');
  });

  it('edits one occurrence ("this") as a move or a standalone copy', async () => {
    const { token } = await h.signIn();
    const r = await daily(token);
    const occurrence = sh('08:30', '2026-11-04');
    expect((await h.request('PATCH', `/v1/reminders/${r.id}`, { token, body: { version: 1, title: 'x' } })).body.error.code).toBe('scope_required');

    const res = await h.request('PATCH', `/v1/reminders/${r.id}`, {
      token,
      body: { version: 1, scope: 'this', occurrence, title: 'Long stretch', at: sh('09:00', '2026-11-04') },
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.created).toMatchObject({ title: 'Long stretch', rrule: null, series_id: r.id });

    const occ = await calendar(token, ...week);
    expect(occ).toHaveLength(7);
    const nov4 = occ.filter((o) => o.at.startsWith('2026-11-04') || o.at.startsWith('2026-11-03T'));
    expect(nov4.map((o) => [o.title, o.at])).toEqual([
      ['Stretch', utc(sh('08:30', '2026-11-03'))],
      ['Long stretch', utc(sh('09:00', '2026-11-04'))],
    ]);
  });

  it('splits the series for "this and following" and moves later overrides to the new part', async () => {
    const { token } = await h.signIn();
    const r = await daily(token);
    await h.request('PUT', `/v1/reminders/${r.id}/occurrences/${encodeURIComponent(sh('08:30', '2026-11-06'))}`, { token, body: { status: 'skipped' } });

    const res = await h.request('PATCH', `/v1/reminders/${r.id}`, {
      token,
      body: { version: 1, scope: 'following', occurrence: sh('08:30', '2026-11-05'), title: 'Yoga' },
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.reminder.until).toBe(utc(sh('08:30', '2026-11-05')));
    expect(res.body.created).toMatchObject({ title: 'Yoga', series_id: r.id, rrule: 'FREQ=DAILY' });

    const occ = await calendar(token, ...week);
    expect(occ.map((o) => o.title)).toEqual(['Stretch', 'Stretch', 'Stretch', 'Yoga', 'Yoga', 'Yoga', 'Yoga']);
    expect(new Set(occ.map((o) => o.series_id))).toEqual(new Set([r.id]));
    expect(occ.find((o) => o.original_at === utc(sh('08:30', '2026-11-06')))).toMatchObject({ status: 'skipped', reminder_id: res.body.created.id });
  });

  it('carries the remaining COUNT into the new part of a split', async () => {
    const { token } = await h.signIn();
    const r = await daily(token, 'Five times', { rrule: 'FREQ=DAILY;COUNT=5' });
    const res = await h.request('PATCH', `/v1/reminders/${r.id}`, {
      token,
      body: { version: 1, scope: 'following', occurrence: sh('08:30', '2026-11-04'), at: sh('07:00', '2026-11-04') },
    });
    expect(res.body.created.rrule).toBe('FREQ=DAILY;COUNT=3');
    const occ = await calendar(token, ...week);
    expect(occ.map((o) => o.at)).toEqual([
      utc(sh('08:30', '2026-11-02')),
      utc(sh('08:30', '2026-11-03')),
      utc(sh('07:00', '2026-11-04')),
      utc(sh('07:00', '2026-11-05')),
      utc(sh('07:00', '2026-11-06')),
    ]);
  });

  it('edits "all" in place, keeping overrides whose original time still exists', async () => {
    const { token } = await h.signIn();
    const r = await daily(token);
    const mark = (day: string) =>
      h.request('PUT', `/v1/reminders/${r.id}/occurrences/${encodeURIComponent(sh('08:30', `2026-11-${day}`))}`, { token, body: { status: 'done' } });
    await mark('04');
    await mark('05');
    const res = await h.request('PATCH', `/v1/reminders/${r.id}`, { token, body: { version: 1, scope: 'all', rrule: 'FREQ=DAILY;INTERVAL=2' } });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const occ = await calendar(token, ...week);
    expect(occ.map((o) => [o.at.slice(0, 10), o.status])).toEqual([
      ['2026-11-02', 'pending'],
      ['2026-11-04', 'done'],
      ['2026-11-06', 'pending'],
      ['2026-11-08', 'pending'],
    ]);
  });

  it('deletes one occurrence, this and following, or all', async () => {
    const { token } = await h.signIn();
    const r = await daily(token);
    const del = (q: string) => h.request('DELETE', `/v1/reminders/${r.id}?${q}`, { token });
    expect((await del(`scope=this&occurrence=${encodeURIComponent(sh('08:30', '2026-11-03'))}`)).status).toBe(204);
    expect((await del(`scope=following&occurrence=${encodeURIComponent(sh('08:30', '2026-11-06'))}`)).status).toBe(204);
    expect((await calendar(token, ...week)).map((o) => o.at.slice(0, 10))).toEqual(['2026-11-02', '2026-11-04', '2026-11-05']);
    expect((await del('scope=all')).status).toBe(204);
    expect(await calendar(token, ...week)).toEqual([]);
  });
});
