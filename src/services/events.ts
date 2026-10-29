import { and, asc, eq, gt, lt, ne, or, sql } from 'drizzle-orm';
import { type Db, type Tx, lockUser, transaction } from '../db/client.js';
import { uuidv7 } from '../db/ids.js';
import { eventRecords, events, goals } from '../db/schema.js';
import type { Deps } from '../deps.js';
import { AppError, cadenzaOverlap, invalidState, notFound, versionConflict } from '../lib/errors.js';
import { decodeCursor, encodeCursor } from '../lib/pagination.js';
import { addMinutes, iso, isoOrNull } from '../lib/time.js';
import {
  type CalendarEvent,
  type CreateResult,
  DEFAULT_GRID_RULES,
  type EventKind,
  MAX_BARS,
  addBars,
  validateEventBlock,
} from '../rules/index.js';

export type EventRow = typeof events.$inferSelect;
export type RecordRow = typeof eventRecords.$inferSelect;
export interface EventWithRecord {
  event: EventRow;
  record: RecordRow | null;
}

export const plannedEnd = (e: Pick<EventRow, 'plannedStart' | 'durationBars'>) => addBars(e.plannedStart, e.durationBars);

/** planned_end in SQL. */
export const plannedEndSql = sql`(${events.plannedStart} + ${events.durationBars} * ${sql.raw(
  `interval '${DEFAULT_GRID_RULES.barMinutes} minutes'`,
)})`;

/** An early start reaches at most this far before the plan (rules.md §3). */
const EARLY_REACH_MINUTES = DEFAULT_GRID_RULES.maxEarlyBars * DEFAULT_GRID_RULES.barMinutes;

/**
 * The block an event occupies for overlap checks and cascades: the plan while planned,
 * [recorded_start, E) while in progress, and the recorded block once done. Only Cadenzas are ever started.
 */
export function effectiveBlock({ event, record }: EventWithRecord): CalendarEvent {
  const end = plannedEnd(event);
  if (event.status === 'in_progress' && record?.recordedStart) {
    return { id: event.id, kind: event.kind, start: record.recordedStart, end, status: event.status };
  }
  if (event.status === 'done' && record?.recordedStart) {
    // Abandoned events have no recorded end and occupy nothing.
    return {
      id: event.id,
      kind: event.kind,
      start: record.recordedStart,
      end: record.recordedEnd ?? record.recordedStart,
      status: 'done',
    };
  }
  return { id: event.id, kind: event.kind, start: event.plannedStart, end, status: event.status };
}

export function eventDto({ event, record }: EventWithRecord) {
  return {
    id: event.id,
    title: event.title,
    notes: event.notes,
    goal_id: event.goalId,
    breakdown_item_id: event.breakdownItemId,
    planned_start: iso(event.plannedStart),
    planned_end: iso(plannedEnd(event)),
    kind: event.kind,
    duration_bars: event.durationBars,
    status: event.status,
    version: event.version,
    record: record
      ? {
          start_tapped_at: isoOrNull(record.startTappedAt),
          finish_tapped_at: isoOrNull(record.finishTappedAt),
          recorded_start: isoOrNull(record.recordedStart),
          recorded_end: isoOrNull(record.recordedEnd),
          early_bars: record.earlyBars,
          late_bars: record.lateBars,
          extended_bars: record.extendedBars,
          finish_kind: record.finishKind,
          tokens_awarded: record.tokensAwarded,
          original_planned_start: iso(record.originalPlannedStart),
          original_planned_end: iso(record.originalPlannedEnd),
          rules_version: record.rulesVersion,
        }
      : null,
    created_at: iso(event.createdAt),
    updated_at: iso(event.updatedAt),
  };
}

const selectEvents = (db: Db) =>
  db.select({ event: events, record: eventRecords }).from(events).leftJoin(eventRecords, eq(eventRecords.eventId, events.id));

/**
 * The user's Cadenzas that the rules look at: any in progress, plus the planned and done ones whose effective
 * block may intersect [from, to) (`to` omitted: no upper bound). Missed Cadenzas and Tuttis never count.
 */
export async function loadCadenzas(db: Db, userId: string, from: Date, to?: Date): Promise<EventWithRecord[]> {
  return selectEvents(db).where(
    and(
      eq(events.userId, userId),
      eq(events.kind, 'cadenza'),
      ne(events.status, 'missed'),
      or(
        eq(events.status, 'in_progress'),
        and(
          to ? lt(events.plannedStart, addMinutes(to, EARLY_REACH_MINUTES)) : undefined,
          sql`${plannedEndSql} > ${from}`,
        ),
      ),
    ),
  );
}

export async function getOwnedEvent(db: Db, userId: string, eventId: string, forUpdate = false): Promise<EventWithRecord> {
  const q = selectEvents(db).where(and(eq(events.id, eventId), eq(events.userId, userId)));
  const [row] = forUpdate ? await q.for('update', { of: events }) : await q;
  if (!row) throw notFound('Event');
  return row;
}

function throwBlockError(result: Exclude<CreateResult, { ok: true }>): never {
  switch (result.error) {
    case 'bar_misaligned':
      throw new AppError(422, 'bar_misaligned', 'planned_start must be on a :00, :20 or :40 mark');
    case 'invalid_duration':
      throw new AppError(422, 'invalid_duration', `duration_bars must be a whole number of 20-minute bars from 1 to ${MAX_BARS}`);
    case 'start_in_past':
      throw new AppError(422, 'start_in_past', 'A Cadenza cannot start before now; the earliest start is the next grid mark');
    case 'cadenza_overlap':
      throw cadenzaOverlap(result.conflicts);
  }
}

async function assertOwnedGoal(db: Db, userId: string, goalId: string | null | undefined) {
  if (!goalId) return;
  const [g] = await db.select({ id: goals.id }).from(goals).where(and(eq(goals.id, goalId), eq(goals.userId, userId)));
  if (!g) throw notFound('Goal');
}

/** Checks a new block, or the edit of `current`, against the rules (rules.md §1, §6). */
async function checkBlock(
  tx: Tx,
  userId: string,
  block: { kind: EventKind; start: Date; durationBars: number },
  now: Date,
  current?: EventWithRecord,
) {
  const { kind, start } = block;
  const end = addBars(start, block.durationBars);
  const calendar: CalendarEvent[] = [];
  if (kind === 'cadenza') {
    for (const row of await loadCadenzas(tx.db, userId, start, end)) {
      if (row.event.id !== current?.event.id) calendar.push(effectiveBlock(row));
    }
    if (current) calendar.push(effectiveBlock(current));
  }
  const result = validateEventBlock({ calendar, kind, start, end, eventId: current?.event.id, now });
  if (!result.ok) throwBlockError(result);
}

export interface CreateEventInput {
  title: string;
  notes?: string | null;
  planned_start: string;
  kind?: EventKind;
  duration_bars: number;
  goal_id?: string | null;
  breakdown_item_id?: string | null;
}

/** Inserts one event inside the caller's transaction, which must hold the user lock. */
export async function insertEvent(tx: Tx, userId: string, input: CreateEventInput, now: Date): Promise<EventWithRecord> {
  const start = new Date(input.planned_start);
  const kind = input.kind ?? 'cadenza';
  await checkBlock(tx, userId, { kind, start, durationBars: input.duration_bars }, now);
  await assertOwnedGoal(tx.db, userId, input.goal_id);
  const [event] = await tx.db
    .insert(events)
    .values({
      id: uuidv7(),
      userId,
      title: input.title,
      notes: input.notes ?? null,
      goalId: input.goal_id ?? null,
      breakdownItemId: input.breakdown_item_id ?? null,
      plannedStart: start,
      kind,
      durationBars: input.duration_bars,
      createdAt: now,
      updatedAt: now,
    })
    .returning();
  return { event: event!, record: null };
}

export async function createEvent(deps: Deps, userId: string, input: CreateEventInput) {
  return transaction(deps.database, async (tx) => {
    await lockUser(tx, userId);
    return eventDto(await insertEvent(tx, userId, input, deps.clock.now()));
  });
}

export interface UpdateEventInput {
  version: number;
  title?: string;
  notes?: string | null;
  planned_start?: string;
  duration_bars?: number;
  kind?: EventKind;
  goal_id?: string | null;
}

/**
 * Edits an event. Only a planned event can be moved, resized or switch kind (rules.md, Editing); a Cadenza that
 * has started, finished or been missed keeps its plan, and what happened is recorded instead.
 */
export async function updateEvent(deps: Deps, userId: string, eventId: string, input: UpdateEventInput) {
  return transaction(deps.database, async (tx) => {
    await lockUser(tx, userId);
    const now = deps.clock.now();
    const current = await getOwnedEvent(tx.db, userId, eventId, true);
    const ev = current.event;
    if (ev.version !== input.version) throw versionConflict();

    const kind = input.kind ?? ev.kind;
    const start = input.planned_start !== undefined ? new Date(input.planned_start) : ev.plannedStart;
    const durationBars = input.duration_bars ?? ev.durationBars;
    const replans = kind !== ev.kind || start.getTime() !== ev.plannedStart.getTime() || durationBars !== ev.durationBars;
    if (replans) {
      if (ev.status !== 'planned') {
        throw invalidState(`Only planned events can be moved, resized or switch kind; this event is ${ev.status}`);
      }
      await checkBlock(tx, userId, { kind, start, durationBars }, now, current);
    }
    if (input.goal_id !== undefined) await assertOwnedGoal(tx.db, userId, input.goal_id);

    const [updated] = await tx.db
      .update(events)
      .set({
        ...(input.title !== undefined ? { title: input.title } : {}),
        ...(input.notes !== undefined ? { notes: input.notes } : {}),
        ...(input.goal_id !== undefined ? { goalId: input.goal_id } : {}),
        kind,
        plannedStart: start,
        durationBars,
        version: ev.version + 1,
        updatedAt: now,
      })
      .where(eq(events.id, ev.id))
      .returning();
    return eventDto({ event: updated!, record: current.record });
  });
}

/**
 * Deletes a planned event along with its change history (ON DELETE CASCADE). There is no cancelled state; a
 * Cadenza that has started, finished or been missed keeps its record and any tokens it earned.
 */
export async function deleteEvent(deps: Deps, userId: string, eventId: string): Promise<void> {
  await transaction(deps.database, async (tx) => {
    await lockUser(tx, userId);
    const { event } = await getOwnedEvent(tx.db, userId, eventId, true);
    if (event.status !== 'planned') throw invalidState(`Only planned events can be deleted; this event is ${event.status}`);
    await tx.db.delete(events).where(eq(events.id, eventId));
  });
}

/** Events whose planned block intersects [from, to). */
const inRange = (userId: string, from: Date, to: Date) =>
  and(eq(events.userId, userId), lt(events.plannedStart, to), sql`${plannedEndSql} > ${from}`);

/** Events in [from, to), ordered by planned_start then id, a page at a time. */
export async function listEvents(db: Db, userId: string, from: Date, to: Date, cursor: string | undefined, limit: number) {
  const c = decodeCursor(cursor, ['s', 'id'] as const);
  const rows = await selectEvents(db)
    .where(
      and(
        inRange(userId, from, to),
        c ? or(gt(events.plannedStart, new Date(c.s)), and(eq(events.plannedStart, new Date(c.s)), gt(events.id, c.id))) : undefined,
      ),
    )
    .orderBy(asc(events.plannedStart), asc(events.id))
    .limit(limit + 1);
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  return {
    items: page.map(eventDto),
    next_cursor: rows.length > limit && last ? encodeCursor({ s: iso(last.event.plannedStart), id: last.event.id }) : null,
  };
}

/** Every event in [from, to), for GET /v1/calendar. */
export async function eventsInRange(db: Db, userId: string, from: Date, to: Date) {
  const rows = await selectEvents(db).where(inRange(userId, from, to)).orderBy(asc(events.plannedStart), asc(events.id));
  return rows.map(eventDto);
}
