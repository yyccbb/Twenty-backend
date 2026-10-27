import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { transaction } from '../../src/db/client.js';
import { uuidv7 } from '../../src/db/ids.js';
import { badges, tokenLedger, users } from '../../src/db/schema.js';
import { syncRewardRule } from '../../src/migrate.js';
import { DEFAULT_REWARD_RULE } from '../../src/rules/index.js';
import { appendLedgerEntry } from '../../src/services/ledger.js';
import { getActiveRewardRule, getRewardRule } from '../../src/services/rewardRules.js';
import { type Harness, sh, startHarness } from './harness.js';

let h: Harness;
beforeAll(async () => {
  h = await startHarness();
});
afterAll(async () => h?.stop());

async function grant(userId: string, delta: number, key = uuidv7()) {
  return transaction(h.database, (tx) =>
    appendLedgerEntry(tx, { userId, delta, reason: 'adjustment', refId: null, rulesVersion: null, idempotencyKey: key }),
  );
}

const balanceOf = async (userId: string) =>
  (await h.database.db.select({ b: users.tokenBalance }).from(users).where(eq(users.id, userId)))[0]!.b;

describe('token ledger', () => {
  it('rejects UPDATE, DELETE and TRUNCATE', async () => {
    const { userId } = await h.signIn();
    const { entry } = await grant(userId, 10);
    await expect(h.database.pool.query('UPDATE token_ledger SET delta = 99 WHERE id = $1', [entry.id])).rejects.toThrow(/append-only/);
    await expect(h.database.pool.query('DELETE FROM token_ledger WHERE id = $1', [entry.id])).rejects.toThrow(/append-only/);
    await expect(h.database.pool.query('TRUNCATE token_ledger CASCADE')).rejects.toThrow(/append-only/);
  });

  it('keeps the cached balance equal to the ledger sum, and an idempotency key pays once', async () => {
    const { userId } = await h.signIn();
    await grant(userId, 10, `k-${userId}`);
    const again = await grant(userId, 10, `k-${userId}`);
    expect(again.created).toBe(false);
    await grant(userId, -3);
    const rows = await h.database.db.select().from(tokenLedger).where(eq(tokenLedger.userId, userId));
    expect(rows.reduce((s, r) => s + r.delta, 0)).toBe(7);
    expect(await balanceOf(userId)).toBe(7);
  });

  it('concurrent finishes of one event pay exactly once', async () => {
    const { token, userId } = await h.signIn();
    const ev = (await h.request('POST', '/v1/events', { token, body: { title: 'x', planned_start: sh('14:00'), duration_slots: 3 } })).body;
    h.clock.set(sh('14:00'));
    await h.request('POST', `/v1/events/${ev.id}/start`, { token, body: { tapped_at: sh('14:00') } });
    h.clock.set(sh('15:00'));
    const results = await Promise.all(
      Array.from({ length: 5 }, () => h.request('POST', `/v1/events/${ev.id}/finish`, { token, body: { tapped_at: sh('15:00') } })),
    );
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    expect(results.filter((r) => r.status === 409)).toHaveLength(4);
    expect(await balanceOf(userId)).toBe(30);
  });

  it('pages history newest first with a cursor', async () => {
    const { token, userId } = await h.signIn();
    for (let i = 1; i <= 5; i++) await grant(userId, i);
    const first = await h.request('GET', '/v1/tokens/ledger?limit=2', { token });
    expect(first.body.balance).toBe(15);
    expect(first.body.entries.map((e: any) => e.delta)).toEqual([5, 4]);
    const second = await h.request('GET', `/v1/tokens/ledger?limit=2&cursor=${first.body.next_cursor}`, { token });
    expect(second.body.entries.map((e: any) => e.delta)).toEqual([3, 2]);
    const third = await h.request('GET', `/v1/tokens/ledger?limit=2&cursor=${second.body.next_cursor}`, { token });
    expect(third.body.entries.map((e: any) => e.delta)).toEqual([1]);
    expect(third.body.next_cursor).toBeNull();
  });
});

describe('badges', () => {
  it('redeems when the balance covers the cost, once per badge', async () => {
    const [badge] = await h.database.db
      .insert(badges)
      .values({ id: uuidv7(), code: `early-bird-${Date.now()}`, name: 'Early bird', cost: 25 })
      .returning();
    const { token, userId } = await h.signIn();

    const poor = await h.request('POST', `/v1/badges/${badge!.id}/redeem`, { token });
    expect(poor.status).toBe(409);
    expect(poor.body.error.code).toBe('insufficient_tokens');

    await grant(userId, 30);
    const ok = await h.request('POST', `/v1/badges/${badge!.id}/redeem`, { token });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ token_balance: 5, ledger_entry: { delta: -25, reason: 'badge_redeem' } });
    expect((await h.request('POST', `/v1/badges/${badge!.id}/redeem`, { token })).body.error.code).toBe('already_owned');

    const list = await h.request('GET', '/v1/badges', { token });
    expect(list.body.badges.find((b: any) => b.id === badge!.id)).toMatchObject({ owned: true });
    expect(await balanceOf(userId)).toBe(5);
  });
});

// Last in the file: it adds reward_rules versions to the shared database.
describe('reward rule sync', () => {
  it('seeds the fixture constants and adds a version only when they change', async () => {
    expect(await getActiveRewardRule(h.database.db)).toStrictEqual({ version: 1, ...DEFAULT_REWARD_RULE });

    await syncRewardRule(h.database.pool);
    expect((await getActiveRewardRule(h.database.db)).version).toBe(1);

    const changed = { ...DEFAULT_REWARD_RULE, tokensPerSlot: DEFAULT_REWARD_RULE.tokensPerSlot + 2 };
    await syncRewardRule(h.database.pool, changed);
    await syncRewardRule(h.database.pool, changed);
    expect(await getActiveRewardRule(h.database.db)).toStrictEqual({ version: 2, ...changed });
    expect(await getRewardRule(h.database.db, 1)).toStrictEqual({ version: 1, ...DEFAULT_REWARD_RULE });
  });
});
