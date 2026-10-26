import { and, eq, or } from 'drizzle-orm';
import { type Db, lockUser, transaction } from '../db/client.js';
import { badges, userBadges, users } from '../db/schema.js';
import type { Deps } from '../deps.js';
import { AppError, notFound } from '../lib/errors.js';
import { iso } from '../lib/time.js';
import { appendLedgerEntry, ledgerDto } from './ledger.js';

type BadgeRow = typeof badges.$inferSelect;

function badgeDto(b: BadgeRow, acquiredAt: Date | null) {
  return {
    id: b.id,
    code: b.code,
    name: b.name,
    description: b.description,
    cost: b.cost,
    image_url: b.imageUrl,
    active: b.active,
    owned: acquiredAt !== null,
    acquired_at: acquiredAt ? iso(acquiredAt) : null,
  };
}

/** The active catalog plus any retired badges the user owns. */
export async function listBadges(db: Db, userId: string) {
  const rows = await db
    .select({ badge: badges, acquiredAt: userBadges.acquiredAt })
    .from(badges)
    .leftJoin(userBadges, and(eq(userBadges.badgeId, badges.id), eq(userBadges.userId, userId)))
    .where(or(eq(badges.active, true), eq(userBadges.userId, userId)))
    .orderBy(badges.cost, badges.code);
  return rows.map((r) => badgeDto(r.badge, r.acquiredAt));
}

/** Spends tokens on a badge: balance check, ledger entry and ownership in one transaction. */
export async function redeemBadge(deps: Deps, userId: string, badgeId: string) {
  return transaction(deps.database, async (tx) => {
    await lockUser(tx, userId);
    const [badge] = await tx.db.select().from(badges).where(and(eq(badges.id, badgeId), eq(badges.active, true)));
    if (!badge) throw notFound('Badge');
    const [owned] = await tx.db
      .select()
      .from(userBadges)
      .where(and(eq(userBadges.userId, userId), eq(userBadges.badgeId, badgeId)));
    if (owned) throw new AppError(409, 'already_owned', 'You already own this badge');
    const [user] = await tx.db.select({ balance: users.tokenBalance }).from(users).where(eq(users.id, userId));
    if (user!.balance < badge.cost) {
      throw new AppError(409, 'insufficient_tokens', `This badge costs ${badge.cost} tokens; you have ${user!.balance}`);
    }
    const { entry } = await appendLedgerEntry(tx, {
      userId,
      delta: -badge.cost,
      reason: 'badge_redeem',
      refId: badge.id,
      rulesVersion: null,
      idempotencyKey: `badge_redeem:${userId}:${badge.id}`,
    });
    const now = deps.clock.now();
    await tx.db.insert(userBadges).values({ userId, badgeId, ledgerEntryId: entry.id, acquiredAt: now });
    return { badge: badgeDto(badge, now), token_balance: user!.balance - badge.cost, ledger_entry: ledgerDto(entry) };
  });
}
