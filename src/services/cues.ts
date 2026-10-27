import { and, asc, eq, gt, gte, inArray, isNull, lt, or } from 'drizzle-orm';
import { type Db, type Tx, lockUser, transaction } from '../db/client.js';
import { uuidv7 } from '../db/ids.js';
import { cueOccurrences, cues, users } from '../db/schema.js';
import type { Deps } from '../deps.js';
import { AppError, notFound, versionConflict } from '../lib/errors.js';
import { iso, isoOrNull } from '../lib/time.js';
import { isValidTimezone } from '../rules/index.js';
import {
  type RecurrenceDef,
  countBefore,
  expandOccurrences,
  isOccurrence,
  normalizeRrule,
  ruleCount,
  withCount,
} from './recurrence.js';

export type CueRow = typeof cues.$inferSelect;
type OverrideRow = typeof cueOccurrences.$inferSelect;
export type Scope = 'this' | 'following' | 'all';
export type OccurrenceStatus = 'pending' | 'done' | 'skipped' | 'snoozed' | 'moved';

export function cueDto(r: CueRow) {
  return {
    id: r.id,
    series_id: r.seriesId,
    title: r.title,
    notes: r.notes,
    at: iso(r.dtstart),
    timezone: r.timezone,
    rrule: r.rrule,
    until: isoOrNull(r.until),
    version: r.version,
    created_at: iso(r.createdAt),
    updated_at: iso(r.updatedAt),
  };
}

const defOf = (r: Pick<CueRow, 'dtstart' | 'timezone' | 'rrule' | 'until'>): RecurrenceDef => ({
  dtstart: r.dtstart,
  timezone: r.timezone,
  rrule: r.rrule,
  until: r.until,
});

/** Cues may sit on any minute, but not between minutes. */
function parseMinute(value: string): Date {
  const t = new Date(value);
  if (t.getTime() % 60_000 !== 0) throw new AppError(422, 'invalid_time', 'Cue times must be whole minutes');
  return t;
}

function assertTimezone(tz: string) {
  if (!isValidTimezone(tz)) throw new AppError(422, 'invalid_timezone', `${tz} is not an IANA time zone`);
}

async function getOwned(db: Db, userId: string, id: string, forUpdate = false): Promise<CueRow> {
  const q = db.select().from(cues).where(and(eq(cues.id, id), eq(cues.userId, userId)));
  const [row] = forUpdate ? await q.for('update') : await q;
  if (!row) throw notFound('Cue');
  return row;
}

function assertOccurrence(r: CueRow, occurrence: string | undefined): Date {
  if (!occurrence) throw new AppError(422, 'occurrence_required', 'occurrence is required for this scope');
  const at = new Date(occurrence);
  if (!isOccurrence(defOf(r), at)) {
    throw new AppError(422, 'invalid_occurrence', 'occurrence is not an original time of this cue');
  }
  return at;
}

async function upsertOverride(tx: Tx, values: typeof cueOccurrences.$inferInsert) {
  await tx.db
    .insert(cueOccurrences)
    .values(values)
    .onConflictDoUpdate({
      target: [cueOccurrences.cueId, cueOccurrences.originalAt],
      set: { status: values.status, newAt: values.newAt ?? null, detachedCueId: values.detachedCueId ?? null, updatedAt: values.updatedAt },
    });
}

async function bump(tx: Tx, r: CueRow, now: Date, set: Partial<typeof cues.$inferInsert> = {}) {
  const [row] = await tx.db
    .update(cues)
    .set({ ...set, version: r.version + 1, updatedAt: now })
    .where(eq(cues.id, r.id))
    .returning();
  return row!;
}

export interface CreateCueInput {
  title: string;
  notes?: string | null;
  at: string;
  timezone?: string;
  rrule?: string | null;
}

export async function createCue(deps: Deps, userId: string, input: CreateCueInput) {
  const dtstart = parseMinute(input.at);
  const rrule = input.rrule ? normalizeRrule(input.rrule) : null;
  const [user] = await deps.database.db.select({ tz: users.timezone }).from(users).where(eq(users.id, userId));
  const timezone = input.timezone ?? user!.tz;
  assertTimezone(timezone);
  const now = deps.clock.now();
  const id = uuidv7();
  const [row] = await deps.database.db
    .insert(cues)
    .values({ id, userId, seriesId: id, title: input.title, notes: input.notes ?? null, dtstart, timezone, rrule, createdAt: now, updatedAt: now })
    .returning();
  return cueDto(row!);
}

export async function getCue(db: Db, userId: string, id: string) {
  return cueDto(await getOwned(db, userId, id));
}

export async function listCues(db: Db, userId: string, cursor: string | undefined, limit: number) {
  const rows = await db
    .select()
    .from(cues)
    .where(and(eq(cues.userId, userId), cursor ? gt(cues.id, cursor) : undefined))
    .orderBy(asc(cues.id))
    .limit(limit + 1);
  const page = rows.slice(0, limit);
  return { items: page.map(cueDto), next_cursor: rows.length > limit ? page[page.length - 1]!.id : null };
}

export interface UpdateCueInput {
  version: number;
  scope?: Scope;
  occurrence?: string;
  title?: string;
  notes?: string | null;
  at?: string;
  timezone?: string;
  rrule?: string | null;
}

/** Keeps the overrides whose original time still exists in `def`; drops the rest. */
async function pruneOverrides(tx: Tx, cueId: string, def: RecurrenceDef, moveTo?: string, fromAt?: Date) {
  const overrides = await tx.db
    .select()
    .from(cueOccurrences)
    .where(
      and(eq(cueOccurrences.cueId, cueId), fromAt ? gte(cueOccurrences.originalAt, fromAt) : undefined),
    );
  for (const o of overrides) {
    const key = and(eq(cueOccurrences.cueId, cueId), eq(cueOccurrences.originalAt, o.originalAt));
    if (!isOccurrence(def, o.originalAt)) await tx.db.delete(cueOccurrences).where(key);
    else if (moveTo) await tx.db.update(cueOccurrences).set({ cueId: moveTo }).where(key);
  }
}

/**
 * Edits a cue. A repeating one takes a scope, like Apple Calendar (spec §3.8):
 * - this: an override for one occurrence (a move), or a standalone copy when its content changes;
 * - following: the series is split at `occurrence` (old part gets an UNTIL, new part shares series_id);
 * - all: the rule is edited in place, keeping overrides whose original time still exists.
 */
export async function updateCue(deps: Deps, userId: string, id: string, input: UpdateCueInput) {
  if (input.timezone !== undefined) assertTimezone(input.timezone);
  const newAt = input.at !== undefined ? parseMinute(input.at) : undefined;
  return transaction(deps.database, async (tx) => {
    await lockUser(tx, userId);
    const r = await getOwned(tx.db, userId, id, true);
    if (r.version !== input.version) throw versionConflict();
    const now = deps.clock.now();
    const rrule = input.rrule === undefined ? r.rrule : input.rrule === null ? null : normalizeRrule(input.rrule);
    const content = {
      ...(input.title !== undefined ? { title: input.title } : {}),
      ...(input.notes !== undefined ? { notes: input.notes } : {}),
      ...(input.timezone !== undefined ? { timezone: input.timezone } : {}),
    };

    let scope: Scope = r.rrule ? (input.scope ?? ('' as Scope)) : 'all';
    if (!scope) throw new AppError(422, 'scope_required', 'scope (this, following or all) is required for a repeating cue');
    const occurrence = scope === 'all' ? null : assertOccurrence(r, input.occurrence);
    if (scope === 'following') {
      const [first] = expandOccurrences(defOf(r), r.dtstart, new Date(occurrence!.getTime() + 1));
      if (first && first.getTime() === occurrence!.getTime()) scope = 'all';
    }

    if (scope === 'all') {
      const updated = await bump(tx, r, now, { ...content, dtstart: newAt ?? r.dtstart, rrule });
      await pruneOverrides(tx, r.id, defOf(updated));
      return { cue: cueDto(updated), created: null };
    }

    if (scope === 'this') {
      if (input.rrule !== undefined) {
        throw new AppError(422, 'invalid_scope', 'The repeat rule cannot be changed for a single occurrence');
      }
      let created: CueRow | null = null;
      if (Object.keys(content).length > 0) {
        const copyId = uuidv7();
        [created] = (await tx.db
          .insert(cues)
          .values({
            id: copyId,
            userId,
            seriesId: r.seriesId,
            title: content.title ?? r.title,
            notes: content.notes !== undefined ? content.notes : r.notes,
            dtstart: newAt ?? occurrence!,
            timezone: content.timezone ?? r.timezone,
            rrule: null,
            createdAt: now,
            updatedAt: now,
          })
          .returning()) as [CueRow];
        await upsertOverride(tx, { cueId: r.id, originalAt: occurrence!, status: 'moved', newAt: created.dtstart, detachedCueId: copyId, updatedAt: now });
      } else if (newAt) {
        await upsertOverride(tx, { cueId: r.id, originalAt: occurrence!, status: 'moved', newAt, updatedAt: now });
      }
      const updated = await bump(tx, r, now);
      return { cue: cueDto(updated), created: created ? cueDto(created) : null };
    }

    // following: split the series at `occurrence`.
    let newRule = rrule;
    const count = r.rrule ? ruleCount(r.rrule) : null;
    if (input.rrule === undefined && r.rrule && count !== null) {
      newRule = withCount(r.rrule, Math.max(1, count - countBefore(defOf(r), occurrence!)));
    }
    const old = await bump(tx, r, now, { until: occurrence! });
    const [created] = await tx.db
      .insert(cues)
      .values({
        id: uuidv7(),
        userId,
        seriesId: r.seriesId,
        title: content.title ?? r.title,
        notes: content.notes !== undefined ? content.notes : r.notes,
        dtstart: newAt ?? occurrence!,
        timezone: content.timezone ?? r.timezone,
        rrule: newRule,
        until: r.until,
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    await pruneOverrides(tx, r.id, defOf(created!), created!.id, occurrence!);
    return { cue: cueDto(old), created: cueDto(created!) };
  });
}

export async function deleteCue(deps: Deps, userId: string, id: string, scope: Scope | undefined, occurrence: string | undefined) {
  await transaction(deps.database, async (tx) => {
    await lockUser(tx, userId);
    const r = await getOwned(tx.db, userId, id, true);
    const now = deps.clock.now();
    let effective: Scope = r.rrule ? (scope ?? ('' as Scope)) : 'all';
    if (!effective) throw new AppError(422, 'scope_required', 'scope (this, following or all) is required for a repeating cue');
    const at = effective === 'all' ? null : assertOccurrence(r, occurrence);
    if (effective === 'following') {
      const [first] = expandOccurrences(defOf(r), r.dtstart, new Date(at!.getTime() + 1));
      if (first && first.getTime() === at!.getTime()) effective = 'all';
    }

    if (effective === 'all') {
      await tx.db.delete(cues).where(eq(cues.id, r.id));
    } else if (effective === 'this') {
      await upsertOverride(tx, { cueId: r.id, originalAt: at!, status: 'cancelled', updatedAt: now });
      await bump(tx, r, now);
    } else {
      await bump(tx, r, now, { until: at! });
      await tx.db
        .delete(cueOccurrences)
        .where(and(eq(cueOccurrences.cueId, r.id), gte(cueOccurrences.originalAt, at!)));
    }
  });
}

function occurrenceDto(r: CueRow, originalAt: Date, o: OverrideRow | undefined) {
  const status: OccurrenceStatus = o && o.status !== 'cancelled' ? o.status : 'pending';
  const at = o && (o.status === 'moved' || o.status === 'snoozed') && o.newAt ? o.newAt : originalAt;
  return {
    cue_id: r.id,
    series_id: r.seriesId,
    title: r.title,
    notes: r.notes,
    original_at: iso(originalAt),
    at: iso(at),
    status,
    repeating: r.rrule !== null,
  };
}

export type OccurrenceDto = ReturnType<typeof occurrenceDto>;

export async function setOccurrenceState(
  deps: Deps,
  userId: string,
  id: string,
  originalAt: string,
  input: { status: OccurrenceStatus; new_at?: string | null },
) {
  return transaction(deps.database, async (tx) => {
    await lockUser(tx, userId);
    const r = await getOwned(tx.db, userId, id, true);
    const at = assertOccurrence(r, originalAt);
    const key = and(eq(cueOccurrences.cueId, r.id), eq(cueOccurrences.originalAt, at));
    const [existing] = await tx.db.select().from(cueOccurrences).where(key);
    if (existing && (existing.status === 'cancelled' || existing.detachedCueId)) {
      throw new AppError(409, 'invalid_state', 'This occurrence was deleted or detached from the series');
    }
    if (input.status === 'pending') {
      await tx.db.delete(cueOccurrences).where(key);
      return occurrenceDto(r, at, undefined);
    }
    const needsTime = input.status === 'snoozed' || input.status === 'moved';
    if (needsTime && !input.new_at) throw new AppError(422, 'new_at_required', `new_at is required when status is ${input.status}`);
    const newAt = needsTime ? parseMinute(input.new_at!) : null;
    const now = deps.clock.now();
    await upsertOverride(tx, { cueId: r.id, originalAt: at, status: input.status, newAt, updatedAt: now });
    const [row] = await tx.db.select().from(cueOccurrences).where(key);
    return occurrenceDto(r, at, row);
  });
}

/** Expanded occurrences whose effective time falls in [from, to), for GET /v1/calendar. */
export async function occurrencesInRange(db: Db, userId: string, from: Date, to: Date): Promise<OccurrenceDto[]> {
  const rows = await db
    .select()
    .from(cues)
    .where(and(eq(cues.userId, userId), lt(cues.dtstart, to), or(isNull(cues.until), gt(cues.until, from))));
  if (rows.length === 0) return [];

  const overrides = await db
    .select()
    .from(cueOccurrences)
    .where(
      and(
        inArray(cueOccurrences.cueId, rows.map((r) => r.id)),
        or(
          and(gte(cueOccurrences.originalAt, from), lt(cueOccurrences.originalAt, to)),
          and(gte(cueOccurrences.newAt, from), lt(cueOccurrences.newAt, to)),
        ),
      ),
    );
  const byKey = new Map(overrides.map((o) => [`${o.cueId}|${o.originalAt.getTime()}`, o]));

  const out: OccurrenceDto[] = [];
  for (const r of rows) {
    const def = defOf(r);
    const originals = expandOccurrences(def, from, to);
    const seen = new Set(originals.map((t) => t.getTime()));
    // Occurrences moved into the range from outside it.
    for (const o of overrides) {
      if (o.cueId === r.id && !seen.has(o.originalAt.getTime()) && isOccurrence(def, o.originalAt)) {
        originals.push(o.originalAt);
      }
    }
    for (const t of originals) {
      const o = byKey.get(`${r.id}|${t.getTime()}`);
      if (o && (o.status === 'cancelled' || o.detachedCueId)) continue;
      const dto = occurrenceDto(r, t, o);
      const at = new Date(dto.at).getTime();
      if (at >= from.getTime() && at < to.getTime()) out.push(dto);
    }
  }
  return out.sort((a, b) => a.at.localeCompare(b.at) || a.cue_id.localeCompare(b.cue_id));
}
