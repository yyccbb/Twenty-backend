import { and, eq, sql } from 'drizzle-orm';
import { type Tx, lockUser, transaction } from '../db/client.js';
import { uuidv7 } from '../db/ids.js';
import { eventChanges, eventRecords, events, users } from '../db/schema.js';
import type { Deps } from '../deps.js';
import { type AutoFinishJob, JOBS } from '../jobs/queue.js';
import { AppError, cadenzaOverlap, invalidState, notCadenza } from '../lib/errors.js';
import { logger } from '../lib/logger.js';
import { addDays, addMinutes, iso } from '../lib/time.js';
import {
  DEFAULT_GRID_RULES,
  type TokenResult,
  addBars,
  barsBetween,
  computeTokens,
  planExtension,
  recordFinish,
  recordStart,
} from '../rules/index.js';
import { type EventWithRecord, effectiveBlock, eventDto, getOwnedEvent, loadCalendar, plannedEnd } from './events.js';
import { appendLedgerEntry } from './ledger.js';
import { getActiveRewardRule, getRewardRule } from './rewardRules.js';
import { getUserContext } from './users.js';

const GRACE_MINUTES = DEFAULT_GRID_RULES.snapAfterMinutes;
/** Upper bound on one extension call (the spec sets none). */
export const MAX_EXTEND_BARS = 72;

/** Offline taps are accepted if the device time is within TAP_MAX_AGE_HOURS and not in the future (spec Q4). */
function assertSaneTap(deps: Deps, tappedAt: Date): void {
  const now = deps.clock.now().getTime();
  const t = tappedAt.getTime();
  if (t > now + deps.config.TAP_MAX_FUTURE_SKEW_SECONDS * 1000) {
    throw new AppError(422, 'tap_in_future', 'tapped_at is ahead of server time; check the device clock');
  }
  if (t < now - deps.config.TAP_MAX_AGE_HOURS * 3_600_000) {
    throw new AppError(422, 'tap_too_old', `tapped_at is more than ${deps.config.TAP_MAX_AGE_HOURS} hours old`);
  }
}

async function scheduleAutoFinish(deps: Deps, tx: Tx, eventId: string, end: Date) {
  const data: AutoFinishJob = { event_id: eventId, expected_end: iso(end) };
  await deps.queue.send(JOBS.autoFinish, data, { startAfter: addMinutes(end, GRACE_MINUTES), tx });
}

export async function startEvent(deps: Deps, userId: string, eventId: string, tappedAt: Date) {
  assertSaneTap(deps, tappedAt);
  return transaction(deps.database, async (tx) => {
    await lockUser(tx, userId);
    const { event, record } = await getOwnedEvent(tx.db, userId, eventId, true);
    if (event.kind !== 'cadenza') throw notCadenza();
    // close_stale may have marked the event missed before a queued offline tap arrived; that tap still counts.
    const closedByJob = event.status === 'missed' && record === null;
    if (event.status !== 'planned' && !closedByJob) {
      throw invalidState(`Only planned events can be started; this event is ${event.status}`);
    }

    const end = plannedEnd(event);
    const calendar = (await loadCalendar(tx.db, userId, addMinutes(event.plannedStart, -60), end)).map(effectiveBlock);
    const result = recordStart({ plannedStart: event.plannedStart, plannedEnd: end, tappedAt, eventId, calendar });
    if (result.outcome === 'rejected') {
      if (result.error === 'cadenza_overlap') throw cadenzaOverlap(result.conflicts);
      throw new AppError(422, 'too_early', 'A Cadenza can be started at most 2 bars (40 min) early');
    }

    const rule = await getActiveRewardRule(tx.db);
    const now = deps.clock.now();
    const started = result.outcome !== 'missed';
    const [rec] = await tx.db
      .insert(eventRecords)
      .values({
        eventId,
        startTappedAt: tappedAt,
        recordedStart: started ? result.recorded_start : null,
        earlyBars: started ? result.early_bars : 0,
        lateBars: started ? result.late_bars : 0,
        originalPlannedStart: event.plannedStart,
        originalPlannedEnd: end,
        rulesVersion: rule.version,
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    const [updated] = await tx.db
      .update(events)
      .set({ status: started ? 'in_progress' : 'missed', version: event.version + 1, updatedAt: now })
      .where(eq(events.id, eventId))
      .returning();

    if (started) {
      if (result.early_bars > 0) {
        await tx.db.insert(eventChanges).values({ id: uuidv7(), eventId, kind: 'early_start', deltaBars: result.early_bars });
      }
      await scheduleAutoFinish(deps, tx, eventId, end);
    }

    return {
      outcome: result.outcome,
      recorded_start: started ? iso(result.recorded_start) : null,
      early_bars: started ? result.early_bars : 0,
      late_bars: started ? result.late_bars : 0,
      event: eventDto({ event: updated!, record: rec! }),
    };
  });
}

const EXTEND_ERRORS = {
  invalid_bars: [422, 'bars must be a whole number of bars, at least 1'],
  not_found: [404, 'Event not found'],
  not_cadenza: [409, 'Only Cadenzas can be started, extended or finished; this event is a Tutti'],
  not_in_progress: [409, 'Only a Cadenza in progress can be extended'],
  window_closed: [409, 'The extend window closed 5 minutes after the planned end'],
  pushed_event_locked: [409, 'The extension would push a Cadenza that is already in progress or done'],
} as const;

export async function extendEvent(deps: Deps, userId: string, eventId: string, bars: number, dryRun: boolean) {
  return transaction(deps.database, async (tx) => {
    await lockUser(tx, userId);
    const now = deps.clock.now();
    const target = await getOwnedEvent(tx.db, userId, eventId, true);
    if (bars > MAX_EXTEND_BARS) {
      throw new AppError(422, 'invalid_bars', `At most ${MAX_EXTEND_BARS} bars can be added at once`);
    }
    const oldEnd = plannedEnd(target.event);
    // Cascades only reach Cadenzas that start after the old end; two weeks is far more than any real chain.
    const rows = await loadCalendar(tx.db, userId, addDays(oldEnd, -1), addDays(oldEnd, 14));
    const byId = new Map(rows.map((r) => [r.event.id, r]));
    byId.set(target.event.id, target);
    const ctx = await getUserContext(tx.db, userId);

    const plan = planExtension({
      calendar: [...byId.values()].map(effectiveBlock),
      eventId,
      bars,
      now,
      timezone: ctx.timezone,
      dayEndLocalTime: ctx.dayEndLocalTime,
    });
    if (!plan.ok) {
      const [status, message] = EXTEND_ERRORS[plan.error];
      throw new AppError(status, plan.error, message, 'conflicts' in plan ? plan.conflicts : undefined);
    }

    let event = target.event;
    let record = target.record;
    const movedVersions = new Map<string, number>();
    if (!dryRun) {
      [event] = (await tx.db
        .update(events)
        .set({ durationBars: event.durationBars + bars, version: event.version + 1, updatedAt: now })
        .where(eq(events.id, eventId))
        .returning()) as [typeof event];
      const [extendedRecord] = await tx.db
        .update(eventRecords)
        .set({ extendedBars: sql`${eventRecords.extendedBars} + ${bars}`, updatedAt: now })
        .where(eq(eventRecords.eventId, eventId))
        .returning();
      record = extendedRecord!;
      await tx.db.insert(eventChanges).values({ id: uuidv7(), eventId, kind: 'extend', deltaBars: bars });
      for (const m of plan.moved) {
        const [shifted] = await tx.db
          .update(events)
          .set({ plannedStart: m.start, version: sql`${events.version} + 1`, updatedAt: now })
          .where(eq(events.id, m.id))
          .returning({ version: events.version });
        movedVersions.set(m.id, shifted!.version);
        // Each Cadenza moves only as far as needed, so its shift can be smaller than the extension.
        const deltaBars = barsBetween(byId.get(m.id)!.event.plannedStart, m.start);
        await tx.db
          .insert(eventChanges)
          .values({ id: uuidv7(), eventId: m.id, kind: 'cascade_shift', deltaBars, causedByEventId: eventId });
      }
      await scheduleAutoFinish(deps, tx, eventId, plan.new_end);
    }

    return {
      dry_run: dryRun,
      new_end: iso(plan.new_end),
      moved: plan.moved.map((m) => ({
        id: m.id,
        planned_start: iso(m.start),
        planned_end: iso(m.end),
        version: movedVersions.get(m.id) ?? byId.get(m.id)!.event.version,
      })),
      day_end_warnings: plan.day_end_warnings,
      event: eventDto({ event, record }),
    };
  });
}

interface FinishOutcome {
  finish_kind: 'on_time' | 'shortened' | 'auto' | 'abandoned';
  recorded_end: string | null;
  tokens: TokenResult;
  tokens_awarded: number;
  token_balance: number;
  event: ReturnType<typeof eventDto>;
}

async function settle(deps: Deps, tx: Tx, current: EventWithRecord, tappedAt: Date | null): Promise<FinishOutcome> {
  const { event } = current;
  const record = current.record!;
  const now = deps.clock.now();
  const result = recordFinish({ recordedStart: record.recordedStart!, plannedEnd: plannedEnd(event), tappedAt });
  const recordedEnd = 'recorded_end' in result ? result.recorded_end : null;
  const rule = await getRewardRule(tx.db, record.rulesVersion);
  const tokens = computeTokens(
    {
      originalStart: record.originalPlannedStart,
      originalEnd: record.originalPlannedEnd,
      recordedStart: record.recordedStart,
      recordedEnd,
      finishKind: result.finish_kind,
    },
    rule,
  );
  const awarded = tokens.tokens;
  // A late-arriving offline tap can replace a job-made auto-finish; the ledger gets a correction entry.
  const correcting = event.status === 'done';
  const previous = record.tokensAwarded ?? 0;

  const [rec] = await tx.db
    .update(eventRecords)
    .set({ finishTappedAt: tappedAt, recordedEnd, finishKind: result.finish_kind, tokensAwarded: awarded, updatedAt: now })
    .where(eq(eventRecords.eventId, event.id))
    .returning();
  const [updated] = await tx.db
    .update(events)
    .set({ status: 'done', version: event.version + 1, updatedAt: now })
    .where(eq(events.id, event.id))
    .returning();

  const delta = correcting ? awarded - previous : awarded;
  if (delta !== 0) {
    await appendLedgerEntry(tx, {
      userId: event.userId,
      delta,
      reason: correcting ? 'adjustment' : 'event_reward',
      refId: event.id,
      rulesVersion: rule.version,
      idempotencyKey: `${correcting ? 'event_reward_correction' : 'event_reward'}:${event.id}`,
    });
  }
  const [u] = await tx.db.select({ balance: users.tokenBalance }).from(users).where(eq(users.id, event.userId));
  return {
    finish_kind: result.finish_kind,
    recorded_end: recordedEnd ? iso(recordedEnd) : null,
    tokens,
    tokens_awarded: awarded,
    token_balance: u!.balance,
    event: eventDto({ event: updated!, record: rec! }),
  };
}

export async function finishEvent(deps: Deps, userId: string, eventId: string, tappedAt: Date) {
  assertSaneTap(deps, tappedAt);
  return transaction(deps.database, async (tx) => {
    await lockUser(tx, userId);
    const current = await getOwnedEvent(tx.db, userId, eventId, true);
    const { event, record } = current;
    if (event.kind !== 'cadenza') throw notCadenza();
    if (event.status === 'in_progress') return settle(deps, tx, current, tappedAt);

    const graceEnd = addMinutes(plannedEnd(event), GRACE_MINUTES);
    const autoByJob = event.status === 'done' && record?.finishKind === 'auto' && record.finishTappedAt === null;
    if (autoByJob && tappedAt.getTime() <= graceEnd.getTime()) return settle(deps, tx, current, tappedAt);
    throw invalidState(`Only an event in progress can be finished; this event is ${event.status}`);
  });
}

/** The events.auto_finish job. A no-op unless the event is still in progress with the same planned end. */
export async function autoFinishEvent(deps: Deps, eventId: string, expectedEnd: Date): Promise<boolean> {
  const [owner] = await deps.database.db.select({ userId: events.userId }).from(events).where(eq(events.id, eventId));
  if (!owner) return false;
  return transaction(deps.database, async (tx) => {
    await lockUser(tx, owner.userId);
    const current = await getOwnedEvent(tx.db, owner.userId, eventId, true);
    const end = plannedEnd(current.event);
    if (current.event.status !== 'in_progress' || end.getTime() !== expectedEnd.getTime()) return false;
    if (deps.clock.now().getTime() < addMinutes(end, GRACE_MINUTES).getTime()) return false;
    await settle(deps, tx, current, null);
    return true;
  });
}

/**
 * The events.close_stale job: planned Cadenzas whose end has passed become missed (Tuttis are left alone).
 * It also auto-finishes any in-progress Cadenza whose auto-finish job was lost, as a safety net.
 */
export async function closeStaleEvents(deps: Deps): Promise<{ missed: number; autoFinished: number }> {
  const now = deps.clock.now();
  const missed = await deps.database.db
    .update(events)
    .set({ status: 'missed', version: sql`${events.version} + 1`, updatedAt: now })
    .where(
      and(
        eq(events.status, 'planned'),
        eq(events.kind, 'cadenza'),
        sql`${events.plannedStart} + ${events.durationBars} * interval '20 minutes' <= ${now}`,
      ),
    )
    .returning({ id: events.id });

  const overdue = await deps.database.db
    .select({ id: events.id, plannedStart: events.plannedStart, durationBars: events.durationBars })
    .from(events)
    .where(
      and(
        eq(events.status, 'in_progress'),
        sql`${events.plannedStart} + ${events.durationBars} * interval '20 minutes' + interval '6 minutes' <= ${now}`,
      ),
    );
  let autoFinished = 0;
  for (const e of overdue) {
    if (await autoFinishEvent(deps, e.id, addBars(e.plannedStart, e.durationBars))) autoFinished++;
  }
  if (missed.length || autoFinished) logger.info({ missed: missed.length, autoFinished }, 'closed stale events');
  return { missed: missed.length, autoFinished };
}
