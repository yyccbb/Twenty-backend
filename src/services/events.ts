import { and, asc, eq, gt, notInArray, or, sql } from 'drizzle-orm';
import { type Db, type Tx, lockUser, transaction } from '../db/client.js';
import { uuidv7 } from '../db/ids.js';
import { eventRecords, events, goals } from '../db/schema.js';
import type { Deps } from '../deps.js';
import { AppError, invalidState, notFound, overlapLimit, versionConflict } from '../lib/errors.js';
import { decodeCursor, encodeCursor } from '../lib/pagination.js';
import { iso, isoOrNull } from '../lib/time.js';
import { type CalendarEvent, type CreateResult, addSlots, validateEventBlock } from '../rules/index.js';

export type EventRow = typeof events.$inferSelect;
export type RecordRow = typeof eventRecords.$inferSelect;
export interface EventWithRecord {
  event: EventRow;
  record: RecordRow | null;
}

/** Upper bound on a planned block (24 h). The spec sets no limit; this only guards against absurd input. */
export const MAX_DURATION_SLOTS = 72;

export const plannedEnd = (e: Pick<EventRow, 'plannedStart' | 'durationSlots'>) => addSlots(e.plannedStart, e.durationSlots);

/**
 * The block an event occupies for overlap checks and cascades: the plan while planned,
 * [recorded_start, E) while in progress, and the recorded block once done.
 */
export function effectiveBlock({ event, record }: EventWithRecord): CalendarEvent {
  const end = plannedEnd(event);
  if (event.status === 'in_progress' && record?.recordedStart) {
    return { id: event.id, start: record.recordedStart, end, status: event.status };
  }
  if (event.status === 'done' && record?.recordedStart) {
    // Abandoned events have no recorded end and occupy nothing.
    return { id: event.id, start: record.recordedStart, end: record.recordedEnd ?? record.recordedStart, status: 'done' };
  }
  return { id: event.id, start: event.plannedStart, end, status: event.status };
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
    duration_slots: event.durationSlots,
    rewardable: event.rewardable,
    status: event.status,
    version: event.version,
    record: record
      ? {
          start_tapped_at: isoOrNull(record.startTappedAt),
          finish_tapped_at: isoOrNull(record.finishTappedAt),
          recorded_start: isoOrNull(record.recordedStart),
          recorded_end: isoOrNull(record.recordedEnd),
          early_slots: record.earlySlots,
          late_slots: record.lateSlots,
          extended_slots: record.extendedSlots,
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

export type EventDto = ReturnType<typeof eventDto>;

/** Active events whose effective block may intersect [from, to). Early starts reach at most 1 h before the plan. */
export async function loadCalendar(db: Db, userId: string, from: Date, to: Date): Promise<EventWithRecord[]> {
  return db
    .select({ event: events, record: eventRecords })
    .from(events)
    .leftJoin(eventRecords, eq(eventRecords.eventId, events.id))
    .where(
      and(
        eq(events.userId, userId),
        notInArray(events.status, ['cancelled', 'missed']),
        sql`${events.plannedStart} - interval '1 hour' < ${to}`,
        sql`${events.plannedStart} + ${events.durationSlots} * interval '20 minutes' > ${from}`,
      ),
    );
}

export async function getOwnedEvent(db: Db, userId: string, eventId: string, forUpdate = false): Promise<EventWithRecord> {
  const q = db
    .select({ event: events, record: eventRecords })
    .from(events)
    .leftJoin(eventRecords, eq(eventRecords.eventId, events.id))
    .where(and(eq(events.id, eventId), eq(events.userId, userId)));
  const [row] = forUpdate ? await q.for('update', { of: events }) : await q;
  if (!row) throw notFound('Event');
  return row;
}

export function throwBlockError(result: Exclude<CreateResult, { ok: true }>): never {
  switch (result.error) {
    case 'slot_misaligned':
      throw new AppError(422, 'slot_misaligned', 'planned_start must be on a :00, :20 or :40 mark');
    case 'invalid_duration':
      throw new AppError(422, 'invalid_duration', 'duration_slots must be a whole number of 20-minute slots, at least 1');
    case 'overlap_limit':
      throw overlapLimit(result.conflicts);
  }
}

export function assertDuration(slots: number): void {
  if (!Number.isInteger(slots) || slots < 1 || slots > MAX_DURATION_SLOTS) {
    throw new AppError(
      422,
      'invalid_duration',
      `duration_slots must be a whole number of 20-minute slots between 1 and ${MAX_DURATION_SLOTS}`,
    );
  }
}

async function assertOwnedGoal(db: Db, userId: string, goalId: string | null | undefined) {
  if (!goalId) return;
  const [g] = await db.select({ id: goals.id }).from(goals).where(and(eq(goals.id, goalId), eq(goals.userId, userId)));
  if (!g) throw notFound('Goal');
}

/** Checks a block against the calendar (including blocks added earlier in the same transaction). */
export async function checkBlock(tx: Tx, userId: string, start: Date, durationSlots: number, ignoreId?: string, extra: CalendarEvent[] = []) {
  assertDuration(durationSlots);
  const end = addSlots(start, durationSlots);
  const calendar = [...(await loadCalendar(tx.db, userId, start, end)).map(effectiveBlock), ...extra];
  const result = validateEventBlock({ calendar, start, end, eventId: ignoreId });
  if (!result.ok) throwBlockError(result);
  return end;
}

export interface CreateEventInput {
  title: string;
  notes?: string | null;
  planned_start: string;
  duration_slots: number;
  rewardable?: boolean;
  goal_id?: string | null;
  breakdown_item_id?: string | null;
}

export async function insertEvent(tx: Tx, deps: Deps, userId: string, input: CreateEventInput, extra: CalendarEvent[] = []) {
  const start = new Date(input.planned_start);
  await checkBlock(tx, userId, start, input.duration_slots, undefined, extra);
  await assertOwnedGoal(tx.db, userId, input.goal_id);
  const now = deps.clock.now();
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
      durationSlots: input.duration_slots,
      rewardable: input.rewardable ?? true,
      createdAt: now,
      updatedAt: now,
    })
    .returning();
  return { event: event!, record: null };
}

export async function createEvent(deps: Deps, userId: string, input: CreateEventInput) {
  return transaction(deps.database, async (tx) => {
    await lockUser(tx, userId);
    return eventDto(await insertEvent(tx, deps, userId, input));
  });
}

export interface UpdateEventInput {
  version: number;
  title?: string;
  notes?: string | null;
  planned_start?: string;
  duration_slots?: number;
  rewardable?: boolean;
  goal_id?: string | null;
}

export async function updateEvent(deps: Deps, userId: string, eventId: string, input: UpdateEventInput) {
  return transaction(deps.database, async (tx) => {
    await lockUser(tx, userId);
    const current = await getOwnedEvent(tx.db, userId, eventId, true);
    const ev = current.event;
    if (ev.version !== input.version) throw versionConflict();

    const reschedules = input.planned_start !== undefined || input.duration_slots !== undefined;
    if ((reschedules || input.rewardable !== undefined) && ev.status !== 'planned') {
      throw invalidState(`Only planned events can be rescheduled; this event is ${ev.status}`);
    }
    const start = input.planned_start !== undefined ? new Date(input.planned_start) : ev.plannedStart;
    const duration = input.duration_slots ?? ev.durationSlots;
    if (reschedules) await checkBlock(tx, userId, start, duration, ev.id);
    if (input.goal_id !== undefined) await assertOwnedGoal(tx.db, userId, input.goal_id);

    const [updated] = await tx.db
      .update(events)
      .set({
        ...(input.title !== undefined ? { title: input.title } : {}),
        ...(input.notes !== undefined ? { notes: input.notes } : {}),
        ...(input.rewardable !== undefined ? { rewardable: input.rewardable } : {}),
        ...(input.goal_id !== undefined ? { goalId: input.goal_id } : {}),
        plannedStart: start,
        durationSlots: duration,
        version: ev.version + 1,
        updatedAt: deps.clock.now(),
      })
      .where(eq(events.id, ev.id))
      .returning();
    return eventDto({ event: updated!, record: current.record });
  });
}

export async function cancelEvent(deps: Deps, userId: string, eventId: string) {
  return transaction(deps.database, async (tx) => {
    await lockUser(tx, userId);
    const current = await getOwnedEvent(tx.db, userId, eventId, true);
    if (current.event.status !== 'planned') {
      throw invalidState(`Only planned events can be cancelled; this event is ${current.event.status}`);
    }
    const [updated] = await tx.db
      .update(events)
      .set({ status: 'cancelled', version: current.event.version + 1, updatedAt: deps.clock.now() })
      .where(eq(events.id, eventId))
      .returning();
    return eventDto({ event: updated!, record: current.record });
  });
}

/** Events whose planned block intersects [from, to), ordered by planned_start then id. */
export async function listEvents(db: Db, userId: string, from: Date, to: Date, cursor: string | undefined, limit: number) {
  const c = decodeCursor(cursor, ['s', 'id'] as const);
  const rows = await db
    .select({ event: events, record: eventRecords })
    .from(events)
    .leftJoin(eventRecords, eq(eventRecords.eventId, events.id))
    .where(
      and(
        eq(events.userId, userId),
        sql`${events.plannedStart} < ${to}`,
        sql`${events.plannedStart} + ${events.durationSlots} * interval '20 minutes' > ${from}`,
        c
          ? or(gt(events.plannedStart, new Date(c.s)), and(eq(events.plannedStart, new Date(c.s)), gt(events.id, c.id)))
          : undefined,
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

/** Every event (any status) whose planned block intersects [from, to), for GET /v1/calendar. */
export async function eventsInRange(db: Db, userId: string, from: Date, to: Date) {
  const rows = await db
    .select({ event: events, record: eventRecords })
    .from(events)
    .leftJoin(eventRecords, eq(eventRecords.eventId, events.id))
    .where(
      and(
        eq(events.userId, userId),
        sql`${events.plannedStart} < ${to}`,
        sql`${events.plannedStart} + ${events.durationSlots} * interval '20 minutes' > ${from}`,
      ),
    )
    .orderBy(asc(events.plannedStart), asc(events.id));
  return rows.map(eventDto);
}
