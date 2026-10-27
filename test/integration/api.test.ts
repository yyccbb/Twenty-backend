import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Harness, sh, startHarness } from './harness.js';

let h: Harness;
beforeAll(async () => {
  h = await startHarness();
});
afterAll(async () => h?.stop());

describe('ops and errors', () => {
  it('serves /healthz without auth and tags responses with a request ID', async () => {
    const res = await h.request('GET', '/healthz', { headers: { 'x-request-id': 'req-123' } });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok' });
    expect(res.headers.get('x-request-id')).toBe('req-123');
  });

  it('uses one error shape', async () => {
    expect((await h.request('GET', '/v1/me')).body).toEqual({
      error: { code: 'unauthorized', message: 'A Bearer access token is required' },
    });
    const { token } = await h.signIn();
    const bad = await h.request('POST', '/v1/events', { token, body: { title: '' } });
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe('invalid_request');
    expect((await h.request('GET', '/v1/nope', { token })).body.error.code).toBe('not_found');
  });
});

describe('auth', () => {
  it('creates the user once and rotates refresh tokens, revoking all sessions on reuse', async () => {
    const sub = `rotate-${Date.now()}`;
    const first = await h.request('POST', '/v1/auth/apple', { body: { id_token: sub } });
    expect(first.body.created).toBe(true);
    const second = await h.request('POST', '/v1/auth/apple', { body: { id_token: sub } });
    expect(second.body).toMatchObject({ created: false, user_id: first.body.user_id });

    const rotated = await h.request('POST', '/v1/auth/refresh', { body: { refresh_token: first.body.refresh_token } });
    expect(rotated.status).toBe(200);
    expect(rotated.body.refresh_token).not.toBe(first.body.refresh_token);

    const reuse = await h.request('POST', '/v1/auth/refresh', { body: { refresh_token: first.body.refresh_token } });
    expect(reuse.body.error.code).toBe('refresh_token_reused');
    // Every session of the user is now revoked, including the other device's.
    for (const t of [rotated.body.refresh_token, second.body.refresh_token]) {
      expect((await h.request('POST', '/v1/auth/refresh', { body: { refresh_token: t } })).status).toBe(401);
    }
  });

  it('rejects bad Apple tokens and expired access tokens; logout revokes', async () => {
    expect((await h.request('POST', '/v1/auth/apple', { body: { id_token: 'bad' } })).status).toBe(401);
    const s = await h.signIn();
    expect((await h.request('GET', '/v1/me', { token: s.accessToken })).status).toBe(200);
    h.clock.advanceMinutes(16);
    expect((await h.request('GET', '/v1/me', { token: s.accessToken })).body.error.code).toBe('invalid_token');
    expect((await h.request('POST', '/v1/auth/logout', { body: { refresh_token: s.refresh } })).status).toBe(204);
    expect((await h.request('POST', '/v1/auth/refresh', { body: { refresh_token: s.refresh } })).status).toBe(401);
  });

  it('rejects non-whole-hour time zones', async () => {
    const res = await h.request('POST', '/v1/auth/apple', { body: { id_token: `tz-${Date.now()}`, timezone: 'Asia/Kolkata' } });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('unsupported_timezone');
  });
});

describe('email auth', () => {
  const uniqueEmail = (tag: string) => `${tag}-${process.pid}-${Date.now()}@example.com`;

  it('signs up, signs in case-insensitively, and the session works', async () => {
    const email = uniqueEmail('Ada');
    const up = await h.request('POST', '/v1/auth/email/signup', {
      body: { email: `  ${email}  `, password: 'correct horse', display_name: 'Ada', timezone: 'Asia/Shanghai' },
    });
    expect(up.status).toBe(201);
    expect(up.body.token_type).toBe('Bearer');

    const me = await h.request('GET', '/v1/me', { token: up.body.access_token });
    expect(me.body).toMatchObject({ id: up.body.user_id, email: email.toLowerCase(), display_name: 'Ada', timezone: 'Asia/Shanghai' });

    const inn = await h.request('POST', '/v1/auth/email/signin', { body: { email: email.toUpperCase(), password: 'correct horse' } });
    expect(inn.status).toBe(200);
    expect(inn.body.user_id).toBe(up.body.user_id);
    expect((await h.request('POST', '/v1/auth/refresh', { body: { refresh_token: inn.body.refresh_token } })).status).toBe(200);
  });

  it('rejects duplicate emails, bad formats and short passwords', async () => {
    const email = uniqueEmail('dup');
    expect((await h.request('POST', '/v1/auth/email/signup', { body: { email, password: 'password1' } })).status).toBe(201);
    const dup = await h.request('POST', '/v1/auth/email/signup', { body: { email: email.toUpperCase(), password: 'password2' } });
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe('email_taken');

    for (const bad of ['no-at-sign', 'a@b', 'a b@example.com', '@example.com']) {
      const res = await h.request('POST', '/v1/auth/email/signup', { body: { email: bad, password: 'password1' } });
      expect(res.status, bad).toBe(400);
    }
    const short = await h.request('POST', '/v1/auth/email/signup', { body: { email: uniqueEmail('short'), password: '1234567' } });
    expect(short.status).toBe(400);
    const tz = await h.request('POST', '/v1/auth/email/signup', {
      body: { email: uniqueEmail('tz'), password: 'password1', timezone: 'Asia/Kolkata' },
    });
    expect(tz.body.error.code).toBe('unsupported_timezone');
  });

  it('gives the same error for a wrong password and an unknown email', async () => {
    const email = uniqueEmail('wrong');
    await h.request('POST', '/v1/auth/email/signup', { body: { email, password: 'password1' } });
    const wrong = await h.request('POST', '/v1/auth/email/signin', { body: { email, password: 'password2' } });
    const unknown = await h.request('POST', '/v1/auth/email/signin', { body: { email: uniqueEmail('nobody'), password: 'password1' } });
    for (const res of [wrong, unknown]) {
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('invalid_credentials');
    }
  });

  it('keeps email and Apple accounts separate', async () => {
    const email = uniqueEmail('apple');
    const viaEmail = await h.request('POST', '/v1/auth/email/signup', { body: { email, password: 'password1' } });
    const viaApple = await h.signIn(`apple-${email}`);
    expect(viaApple.userId).not.toBe(viaEmail.body.user_id);
    expect((await h.request('GET', '/v1/me', { token: viaApple.token })).body.email).toBeNull();
  });

  it('DELETE /v1/me frees the email for a new account', async () => {
    const email = uniqueEmail('delete');
    const up = await h.request('POST', '/v1/auth/email/signup', { body: { email, password: 'password1' } });
    expect((await h.request('DELETE', '/v1/me', { token: up.body.access_token })).status).toBe(204);
    expect((await h.request('POST', '/v1/auth/email/signin', { body: { email, password: 'password1' } })).status).toBe(401);
    const again = await h.request('POST', '/v1/auth/email/signup', { body: { email, password: 'password1' } });
    expect(again.status).toBe(201);
    expect(again.body.user_id).not.toBe(up.body.user_id);
  });
});

describe('account', () => {
  it('reads and updates settings', async () => {
    const { token } = await h.signIn();
    const me = await h.request('GET', '/v1/me', { token });
    expect(me.body).toMatchObject({ timezone: 'Asia/Shanghai', timezone_supported: true, token_balance: 0 });
    expect(me.body.settings.day_end_local_time).toBe('00:00');

    const patch = await h.request('PATCH', '/v1/me/settings', {
      token,
      body: {
        timezone: 'America/New_York',
        day_end_local_time: '02:00',
        planning_prompts: [{ weekday: [1, 2, 3, 4, 5], local_time: '21:30' }],
      },
    });
    expect(patch.status).toBe(200);
    expect(patch.body).toMatchObject({ timezone: 'America/New_York', settings: { day_end_local_time: '02:00' } });
    expect(patch.body.settings.planning_prompts).toHaveLength(1);

    const nepal = await h.request('PATCH', '/v1/me/settings', { token, body: { timezone: 'Asia/Kathmandu' } });
    expect(nepal.body.error.code).toBe('unsupported_timezone');
  });

  it('DELETE /v1/me removes personal data and blocks the account; the Apple ID can sign up afresh', async () => {
    const sub = `delete-${Date.now()}`;
    const s = await h.signIn(sub);
    await h.request('POST', '/v1/events', { token: s.token, body: { title: 'x', planned_start: sh('14:00'), duration_bars: 1 } });
    expect((await h.request('DELETE', '/v1/me', { token: s.token })).status).toBe(204);
    expect((await h.request('GET', '/v1/me', { token: s.token })).status).toBe(401);
    expect((await h.request('POST', '/v1/auth/refresh', { body: { refresh_token: s.refresh } })).status).toBe(401);
    const again = await h.request('POST', '/v1/auth/apple', { body: { id_token: sub } });
    expect(again.body.created).toBe(true);
    expect(again.body.user_id).not.toBe(s.userId);
  });
});

describe('events CRUD', () => {
  it('rejects off-grid starts, non-whole bars and a Cadenza overlapping another Cadenza', async () => {
    const { token } = await h.signIn();
    const post = (planned_start: string, duration_bars: number, kind?: 'cadenza' | 'tutti') =>
      h.request('POST', '/v1/events', { token, body: { title: 'x', planned_start, duration_bars, kind } });
    expect((await post(sh('14:10'), 1)).body.error.code).toBe('bar_misaligned');
    expect((await post(sh('14:10'), 1, 'tutti')).body.error.code).toBe('bar_misaligned');
    expect((await post(sh('14:00'), 1.5)).body.error.code).toBe('invalid_duration');
    expect((await post(sh('14:00'), 0)).body.error.code).toBe('invalid_duration');
    const a = await post(sh('14:00'), 3);
    expect(a.body.kind).toBe('cadenza');
    const b = await post(sh('14:40'), 2);
    expect(b.status).toBe(409);
    expect(b.body.error).toMatchObject({ code: 'cadenza_overlap', conflicts: [a.body.id] });
    expect((await post(sh('15:00'), 1)).status).toBe(201);
    // Tuttis overlap anything, without limit.
    for (let i = 0; i < 3; i++) expect((await post(sh('14:20'), 2, 'tutti')).status).toBe(201);
  });

  it('switches kind on planned events only, checking overlap when becoming a Cadenza', async () => {
    const { token } = await h.signIn();
    const post = (planned_start: string, duration_bars: number, kind: 'cadenza' | 'tutti') =>
      h.request('POST', '/v1/events', { token, body: { title: 'x', planned_start, duration_bars, kind } });
    const a = (await post(sh('14:00'), 3, 'cadenza')).body;
    const t = (await post(sh('14:20'), 1, 'tutti')).body;
    const clash = await h.request('PATCH', `/v1/events/${t.id}`, { token, body: { version: t.version, kind: 'cadenza' } });
    expect(clash.body.error).toMatchObject({ code: 'cadenza_overlap', conflicts: [a.id] });

    const toTutti = await h.request('PATCH', `/v1/events/${a.id}`, { token, body: { version: a.version, kind: 'tutti' } });
    expect(toTutti.body).toMatchObject({ kind: 'tutti', version: a.version + 1 });
    const toCadenza = await h.request('PATCH', `/v1/events/${t.id}`, { token, body: { version: t.version, kind: 'cadenza' } });
    expect(toCadenza.body.kind).toBe('cadenza');

    h.clock.set(sh('14:20'));
    await h.request('POST', `/v1/events/${t.id}/start`, { token, body: { tapped_at: sh('14:20') } });
    const started = await h.request('PATCH', `/v1/events/${t.id}`, { token, body: { version: toCadenza.body.version + 1, kind: 'tutti' } });
    expect(started.body.error.code).toBe('invalid_state');
    h.clock.set('2026-11-02T05:00:00Z');
  });

  it('uses optimistic locking on PATCH and cancels with DELETE', async () => {
    const { token } = await h.signIn();
    const ev = (await h.request('POST', '/v1/events', { token, body: { title: 'x', planned_start: sh('14:00'), duration_bars: 1 } })).body;
    const moved = await h.request('PATCH', `/v1/events/${ev.id}`, { token, body: { version: 1, planned_start: sh('16:00') } });
    expect(moved.body).toMatchObject({ version: 2, planned_start: new Date(sh('16:00')).toISOString() });
    const stale = await h.request('PATCH', `/v1/events/${ev.id}`, { token, body: { version: 1, title: 'y' } });
    expect(stale.body.error.code).toBe('version_conflict');
    const cancelled = await h.request('DELETE', `/v1/events/${ev.id}`, { token });
    expect(cancelled.body.status).toBe('cancelled');
    // Cancelled events don't count toward the overlap rule.
    expect((await h.request('GET', `/v1/events/${ev.id}`, { token })).body.status).toBe('cancelled');
  });

  it('pages a range with a cursor and supports ETags', async () => {
    const { token } = await h.signIn();
    for (const t of ['14:00', '15:00', '16:00']) {
      await h.request('POST', '/v1/events', { token, body: { title: t, planned_start: sh(t), duration_bars: 1 } });
    }
    const range = `from=${encodeURIComponent(sh('00:00'))}&to=${encodeURIComponent(sh('00:00', '2026-11-03'))}`;
    const p1 = await h.request('GET', `/v1/events?${range}&limit=2`, { token });
    expect(p1.body.items.map((e: any) => e.title)).toEqual(['14:00', '15:00']);
    const p2 = await h.request('GET', `/v1/events?${range}&limit=2&cursor=${p1.body.next_cursor}`, { token });
    expect(p2.body.items.map((e: any) => e.title)).toEqual(['16:00']);
    expect(p2.body.next_cursor).toBeNull();

    const etag = p1.headers.get('etag')!;
    expect(etag).toBeTruthy();
    const cached = await h.request('GET', `/v1/events?${range}&limit=2`, { token, headers: { 'if-none-match': etag } });
    expect(cached.status).toBe(304);
  });
});
