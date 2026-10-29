import { and, eq, sql } from 'drizzle-orm';
import { type Tx, lockUser, transaction } from '../db/client.js';
import { uuidv7 } from '../db/ids.js';
import { eventChanges, eventRecords, events, users } from '../db/schema.js';
import type { Deps } from '../deps.js';
import { type AutoFinishJob, JOBS } from '../jobs/queue.js';
import { AppError, cadenzaOverlap, invalidState, notCadenza, notFound } from '../lib/errors.js';
import { logger } from '../lib/logger.js';
import { addMinutes, iso } from '../lib/time.js';
import {
  type CalendarEvent,
  DEFAULT_GRID_RULES,
  type ExtendResult,
  MAX_BARS,
  addBars,
  barsBetween,
  computeTokens,
  planExtension,
  recordFinish,
  recordStart,
} from '../rules/index.js';
import {
  type EventRow,
  type EventWithRecord,
  type RecordRow,
  effectiveBlock,
  eventDto,
  getOwnedEvent,
  loadCadenzas,
  plannedEnd,
  plannedEndSql,
} from './events.js';
import { appendLedgerEntry } from './ledger.js';
import { getActiveRewardRule, getRewardRule } from './rewardRules.js';
import { getUserContext } from './users.js';

const GRACE_MINUTES = DEFAULT_GRID_RULES.snapAfterMinutes;

/** E + 5: the finish window closes and the Cadenza is auto-finished (rules.md §4). */
const autoFinishAt = (event: EventRow) => addMinutes(plannedEnd(event), GRACE_MINUTES);

/** Device tap times are accepted up to TAP_MAX_AGE_HOURS old and TAP_MAX_FUTURE_SKEW_SECONDS ahead (rules.md §2). */
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

async function scheduleAutoFinish(deps: Deps, tx: Tx, event: EventRow) {
  const data: AutoFinishJob = { event_id: event.id, expected_end: iso(plannedEnd(event)) };
  await deps.queue.send(JOBS.autoFinish, data, { startAfter: autoFinishAt(event), tx });
}

export async function startEvent(deps: Deps, userId: string, eventId: string, tappedAt: Date) {
  assertSaneTap(deps, tappedAt);
  return transaction(deps.database, async (tx) => {
    await lockUser(tx, userId);
    const now = deps.clock.now();
    const { event, record } = await getOwnedEvent(tx.db, userId, eventId, true);
    if (event.kind !== 'cadenza') throw notCadenza();
    // close_stale may have marked the event missed before a queued offline tap arrived; that tap still counts.
    const closedByJob = event.status === 'missed' && record === null;
    if (event.status !== 'planned' && !closedByJob) {
      throw invalidState(`Only planned events can be started; this event is ${event.status}`);
    }

    const end = plannedEnd(event);
    const calendar: CalendarEvent[] = [];
    for (const row of await loadCadenzas(tx.db, userId, addBars(event.plannedStart, -DEFAULT_GRID_RULES.maxEarlyBars), end)) {
      // A Cadenza is auto-finished at E + 5 even if its job hasn't run yet, so it no longer blocks this start.
      const overdue = row.event.status === 'in_progress' && now.getTime() >= autoFinishAt(row.event).getTime();
      calendar.push(effectiveBlock(overdue ? (await settle(deps, tx, row, null)).row : row));
    }
    const result = recordStart({ plannedStart: event.plannedStart, plannedEnd: end, tappedAt, eventId, calendar });
    if (result.outcome === 'rejected') {
      switch (result.error) {
        case 'too_early':
          throw new AppError(422, 'too_early', 'A Cadenza can be started at most 2 bars (40 min) early');
        case 'cadenza_in_progress':
          throw new AppError(409, 'cadenza_in_progress', 'Another Cadenza is still in progress; finish it first', result.conflicts);
        case 'cadenza_overlap':
          throw cadenzaOverlap(result.conflicts);
      }
    }

    const rule = await getActiveRewardRule(tx.db);
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
      await scheduleAutoFinish(deps, tx, updated!);
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

function extendError(plan: Extract<ExtendResult, { ok: false }>): AppError {
  switch (plan.error) {
    case 'invalid_bars':
      return new AppError(422, 'invalid_bars', `bars must be a whole number from 1 to ${MAX_BARS}`);
    case 'not_found':
      return notFound('Event');
    case 'not_cadenza':
      return notCadenza();
    case 'not_in_progress':
      return invalidState('Only a Cadenza in progress can be extended');
    case 'window_closed':
      return new AppError(409, 'window_closed', 'The extend window closed 5 minutes after the planned end');
    case 'pushed_event_locked':
      return new AppError(409, 'pushed_event_locked', 'The extension would push a Cadenza that has already started', plan.conflicts);
  }
}

export async function extendEvent(deps: Deps, userId: string, eventId: string, bars: number, dryRun: boolean) {
  return transaction(deps.database, async (tx) => {
    await lockUser(tx, userId);
    const now = deps.clock.now();
    const target = await getOwnedEvent(tx.db, userId, eventId, true);
    // The cascade can reach any later Cadenza, so there is no upper bound.
    const rows = await loadCadenzas(tx.db, userId, effectiveBlock(target).start);
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
    if (!plan.ok) throw extendError(plan);

    let { event, record } = target;
    const movedVersions = new Map<string, number>();
    if (!dryRun) {
      [event] = (await tx.db
        .update(events)
        .set({ durationBars: event.durationBars + bars, version: event.version + 1, updatedAt: now })
        .where(eq(events.id, eventId))
        .returning()) as [EventRow];
      [record] = (await tx.db
        .update(eventRecords)
        .set({ extendedBars: sql`${eventRecords.extendedBars} + ${bars}`, updatedAt: now })
        .where(eq(eventRecords.eventId, eventId))
        .returning()) as [RecordRow];
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
      await scheduleAutoFinish(deps, tx, event);
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

/**
 * Finishes an in-progress Cadenza from a tap, or as an auto-finish when `tappedAt` is null, and pays for it.
 * On a Cadenza the job already auto-finished, a tap made by E + 5 replaces that result with a ledger adjustment.
 */
async function settle(deps: Deps, tx: Tx, current: EventWithRecord, tappedAt: Date | null) {
  const { event } = current;
  const record = current.record!;
  const now = deps.clock.now();
  const result = recordFinish({ recordedStart: record.recordedStart!, plannedEnd: plannedEnd(event), tappedAt });
  if ('error' in result) throw new AppError(409, 'window_closed', 'The finish window closed 5 minutes after the planned end');
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
  const correcting = event.status === 'done';

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

  const delta = correcting ? awarded - (record.tokensAwarded ?? 0) : awarded;
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
  const row: EventWithRecord = { event: updated!, record: rec! };
  return {
    row,
    body: {
      finish_kind: result.finish_kind,
      recorded_end: recordedEnd ? iso(recordedEnd) : null,
      tokens,
      tokens_awarded: awarded,
      token_balance: u!.balance,
      event: eventDto(row),
    },
  };
}

export async function finishEvent(deps: Deps, userId: string, eventId: string, tappedAt: Date) {
  assertSaneTap(deps, tappedAt);
  return transaction(deps.database, async (tx) => {
    await lockUser(tx, userId);
    const current = await getOwnedEvent(tx.db, userId, eventId, true);
    const { event, record } = current;
    if (event.kind !== 'cadenza') throw notCadenza();
    // Only one finish tap counts: the first, or one that replaces the job's auto-finish (rules.md §4).
    const autoByJob = event.status === 'done' && record?.finishKind === 'auto' && record.finishTappedAt === null;
    if (event.status !== 'in_progress' && !autoByJob) {
      throw invalidState(`Only a Cadenza in progress can be finished; this event is ${event.status}`);
    }
    return (await settle(deps, tx, current, tappedAt)).body;
  });
}

/** The events.auto_finish job. A no-op unless the event is still in progress with the same planned end. */
export async function autoFinishEvent(deps: Deps, eventId: string, expectedEnd: Date): Promise<boolean> {
  const [owner] = await deps.database.db.select({ userId: events.userId }).from(events).where(eq(events.id, eventId));
  if (!owner) return false;
  return transaction(deps.database, async (tx) => {
    await lockUser(tx, owner.userId);
    const current = await getOwnedEvent(tx.db, owner.userId, eventId, true);
    const { event } = current;
    if (event.status !== 'in_progress' || plannedEnd(event).getTime() !== expectedEnd.getTime()) return false;
    if (deps.clock.now().getTime() < autoFinishAt(event).getTime()) return false;
    await settle(deps, tx, current, null);
    return true;
  });
}

/**
 * The events.close_stale job: planned Cadenzas whose end has passed become missed (Tuttis are left alone).
 * As a safety net it also auto-finishes any Cadenza still in progress more than 6 minutes after E, in case
 * its auto-finish job was lost (rules.md §4).
 */
export async function closeStaleEvents(deps: Deps): Promise<{ missed: number; autoFinished: number }> {
  const now = deps.clock.now();
  const missed = await deps.database.db
    .update(events)
    .set({ status: 'missed', version: sql`${events.version} + 1`, updatedAt: now })
    .where(and(eq(events.status, 'planned'), eq(events.kind, 'cadenza'), sql`${plannedEndSql} <= ${now}`))
    .returning({ id: events.id });

  const overdue = await deps.database.db
    .select({ id: events.id, plannedStart: events.plannedStart, durationBars: events.durationBars })
    .from(events)
    .where(and(eq(events.status, 'in_progress'), sql`${plannedEndSql} + interval '6 minutes' < ${now}`));
  let autoFinished = 0;
  for (const e of overdue) {
    if (await autoFinishEvent(deps, e.id, plannedEnd(e))) autoFinished++;
  }
  if (missed.length || autoFinished) logger.info({ missed: missed.length, autoFinished }, 'closed stale events');
  return { missed: missed.length, autoFinished };
}
