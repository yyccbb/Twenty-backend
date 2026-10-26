import { and, desc, eq, lt, sql } from 'drizzle-orm';
import type { Db, Tx } from '../db/client.js';
import { uuidv7 } from '../db/ids.js';
import { tokenLedger, users } from '../db/schema.js';
import { iso } from '../lib/time.js';

export type LedgerRow = typeof tokenLedger.$inferSelect;

export interface LedgerEntryInput {
  userId: string;
  delta: number;
  reason: 'event_reward' | 'badge_redeem' | 'adjustment';
  refId: string | null;
  rulesVersion: number | null;
  /** Derived from what is being paid for, so a retry can never pay twice. */
  idempotencyKey: string;
}

/**
 * Appends a ledger entry and updates the cached balance in the same transaction.
 * If the idempotency key already exists, nothing changes and the existing entry is returned.
 */
export async function appendLedgerEntry(tx: Tx, input: LedgerEntryInput): Promise<{ entry: LedgerRow; created: boolean }> {
  const [inserted] = await tx.db
    .insert(tokenLedger)
    .values({ id: uuidv7(), ...input })
    .onConflictDoNothing({ target: tokenLedger.idempotencyKey })
    .returning();
  if (inserted) {
    await tx.db
      .update(users)
      .set({ tokenBalance: sql`${users.tokenBalance} + ${input.delta}` })
      .where(eq(users.id, input.userId));
    return { entry: inserted, created: true };
  }
  const [existing] = await tx.db.select().from(tokenLedger).where(eq(tokenLedger.idempotencyKey, input.idempotencyKey));
  if (!existing || existing.userId !== input.userId) throw new Error('ledger idempotency key collision');
  return { entry: existing, created: false };
}

export function ledgerDto(e: LedgerRow) {
  return {
    id: e.id,
    delta: e.delta,
    reason: e.reason,
    ref_id: e.refId,
    rules_version: e.rulesVersion,
    created_at: iso(e.createdAt),
  };
}

/** Newest first. UUIDv7 IDs sort by creation time, so the ID alone is the cursor. */
export async function listLedger(db: Db, userId: string, cursor: string | null, limit: number) {
  const rows = await db
    .select()
    .from(tokenLedger)
    .where(and(eq(tokenLedger.userId, userId), cursor ? lt(tokenLedger.id, cursor) : undefined))
    .orderBy(desc(tokenLedger.id))
    .limit(limit + 1);
  const page = rows.slice(0, limit);
  return { entries: page, nextCursor: rows.length > limit ? page[page.length - 1]!.id : null };
}
