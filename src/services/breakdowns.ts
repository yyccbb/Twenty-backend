import { and, count, eq, gte } from 'drizzle-orm';
import { AiOutputError, BREAKDOWN_PROMPT_VERSION, generateBreakdown } from '../ai/index.js';
import { type Db, lockUser, transaction } from '../db/client.js';
import { uuidv7 } from '../db/ids.js';
import { aiBreakdowns, goals } from '../db/schema.js';
import type { Deps } from '../deps.js';
import { type BreakdownJob, JOBS } from '../jobs/queue.js';
import { AppError, invalidState, notFound } from '../lib/errors.js';
import { logger } from '../lib/logger.js';
import { iso } from '../lib/time.js';
import { type CalendarEvent, addSlots, localParts, localToUtc } from '../rules/index.js';
import { eventDto, insertEvent } from './events.js';
import { getOwnedGoal } from './goals.js';
import { getUserContext } from './users.js';

type BreakdownRow = typeof aiBreakdowns.$inferSelect;

export const DEFAULT_MAX_ITEMS = 8;

export function breakdownDto(b: BreakdownRow) {
  return {
    id: b.id,
    goal_id: b.goalId,
    status: b.status,
    model: b.model,
    prompt_version: b.promptVersion,
    summary: b.result?.summary ?? null,
    items: b.result?.items ?? null,
    error: b.error,
    created_at: iso(b.createdAt),
    updated_at: iso(b.updatedAt),
  };
}

function startOfLocalDay(now: Date, tz: string): Date {
  const p = localParts(now, tz);
  return localToUtc(tz, p.year, p.month, p.day, 0, 0);
}

/** Queues an AI breakdown (202 + poll). Enforces the per-user daily limit, counted in the user's local day. */
export async function requestBreakdown(
  deps: Deps,
  userId: string,
  goalId: string,
  input: { hints?: string | null; max_items?: number },
) {
  return transaction(deps.database, async (tx) => {
    await lockUser(tx, userId);
    await getOwnedGoal(tx.db, userId, goalId);
    const now = deps.clock.now();
    const { timezone } = await getUserContext(tx.db, userId);
    const [used] = await tx.db
      .select({ n: count() })
      .from(aiBreakdowns)
      .where(and(eq(aiBreakdowns.userId, userId), gte(aiBreakdowns.createdAt, startOfLocalDay(now, timezone))));
    if ((used?.n ?? 0) >= deps.config.AI_DAILY_BREAKDOWN_LIMIT) {
      throw new AppError(429, 'daily_limit_reached', `At most ${deps.config.AI_DAILY_BREAKDOWN_LIMIT} breakdowns per day`);
    }
    const id = uuidv7();
    await tx.db.insert(aiBreakdowns).values({
      id,
      goalId,
      userId,
      promptVersion: BREAKDOWN_PROMPT_VERSION,
      request: { hints: input.hints ?? null, max_items: input.max_items ?? DEFAULT_MAX_ITEMS },
      createdAt: now,
      updatedAt: now,
    });
    const job: BreakdownJob = { breakdown_id: id };
    await deps.queue.send(JOBS.aiBreakdown, job, { tx });
    return { breakdown_id: id, status: 'queued' as const };
  });
}

export async function getBreakdown(db: Db, userId: string, id: string) {
  const [b] = await db.select().from(aiBreakdowns).where(and(eq(aiBreakdowns.id, id), eq(aiBreakdowns.userId, userId)));
  if (!b) throw notFound('Breakdown');
  return breakdownDto(b);
}

/**
 * The ai.breakdown job. Invalid model output fails the breakdown at once; transient errors (network,
 * rate limits) are rethrown so pg-boss retries, and fail the breakdown only on the last attempt.
 */
export async function runBreakdownJob(deps: Deps, breakdownId: string, opts: { finalAttempt: boolean; signal?: AbortSignal }) {
  const db = deps.database.db;
  const [b] = await db.select().from(aiBreakdowns).where(eq(aiBreakdowns.id, breakdownId));
  if (!b || b.status === 'done' || b.status === 'failed') return;
  const [goal] = await db.select().from(goals).where(eq(goals.id, b.goalId));
  if (!goal) return;
  const setStatus = (set: Partial<typeof aiBreakdowns.$inferInsert>) =>
    db.update(aiBreakdowns).set({ ...set, updatedAt: deps.clock.now() }).where(eq(aiBreakdowns.id, breakdownId));

  await setStatus({ status: 'running' });
  try {
    const { timezone } = await getUserContext(db, b.userId);
    const p = localParts(deps.clock.now(), timezone);
    const out = await generateBreakdown(
      deps.ai,
      {
        goal: { title: goal.title, description: goal.description, target_date: goal.targetDate },
        hints: b.request.hints,
        maxItems: b.request.max_items,
        today: `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`,
      },
      opts.signal,
    );
    await setStatus({
      status: 'done',
      model: out.model,
      result: { summary: out.summary, items: out.items },
      tokensUsed: out.tokensUsed,
      error: null,
    });
  } catch (err) {
    const permanent = err instanceof AiOutputError;
    logger.warn({ err, breakdownId, permanent }, 'breakdown attempt failed');
    if (permanent || opts.finalAttempt) {
      await setStatus({ status: 'failed', error: permanent ? err.message : 'The AI service is unavailable; try again later' });
      return;
    }
    await setStatus({ status: 'queued' });
    throw err;
  }
}

export interface AcceptItem {
  item_id: string;
  planned_start: string;
  duration_slots?: number;
  title?: string;
  notes?: string | null;
}

/** Places chosen breakdown items on the calendar as events, all in one transaction. */
export async function acceptBreakdown(deps: Deps, userId: string, id: string, items: AcceptItem[]) {
  return transaction(deps.database, async (tx) => {
    await lockUser(tx, userId);
    const [b] = await tx.db.select().from(aiBreakdowns).where(and(eq(aiBreakdowns.id, id), eq(aiBreakdowns.userId, userId)));
    if (!b) throw notFound('Breakdown');
    if (b.status !== 'done' || !b.result) throw invalidState(`The breakdown is ${b.status}`);
    const byId = new Map(b.result.items.map((i) => [i.id, i]));

    const added: CalendarEvent[] = [];
    const created = [];
    for (const choice of items) {
      const item = byId.get(choice.item_id);
      if (!item) throw new AppError(422, 'unknown_item', `Item ${choice.item_id} is not part of this breakdown`);
      const slots = choice.duration_slots ?? item.duration_slots;
      const row = await insertEvent(
        tx,
        deps,
        userId,
        {
          title: choice.title ?? item.title,
          notes: choice.notes !== undefined ? choice.notes : item.description,
          planned_start: choice.planned_start,
          duration_slots: slots,
          goal_id: b.goalId,
          breakdown_item_id: item.id,
        },
        added,
      );
      added.push({ id: row.event.id, start: row.event.plannedStart, end: addSlots(row.event.plannedStart, slots), status: 'planned' });
      created.push(eventDto(row));
    }
    return { events: created };
  });
}
