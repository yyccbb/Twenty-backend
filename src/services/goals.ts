import { and, asc, eq, gt } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { uuidv7 } from '../db/ids.js';
import { goals } from '../db/schema.js';
import type { Deps } from '../deps.js';
import { notFound } from '../lib/errors.js';
import { iso } from '../lib/time.js';

export type GoalRow = typeof goals.$inferSelect;
export type GoalStatus = GoalRow['status'];

export function goalDto(g: GoalRow) {
  return {
    id: g.id,
    title: g.title,
    description: g.description,
    target_date: g.targetDate,
    status: g.status,
    created_at: iso(g.createdAt),
    updated_at: iso(g.updatedAt),
  };
}

export async function getOwnedGoal(db: Db, userId: string, id: string): Promise<GoalRow> {
  const [g] = await db.select().from(goals).where(and(eq(goals.id, id), eq(goals.userId, userId)));
  if (!g) throw notFound('Goal');
  return g;
}

export async function createGoal(
  deps: Deps,
  userId: string,
  input: { title: string; description?: string | null; target_date?: string | null },
) {
  const now = deps.clock.now();
  const [g] = await deps.database.db
    .insert(goals)
    .values({
      id: uuidv7(),
      userId,
      title: input.title,
      description: input.description ?? null,
      targetDate: input.target_date ?? null,
      createdAt: now,
      updatedAt: now,
    })
    .returning();
  return goalDto(g!);
}

export async function listGoals(db: Db, userId: string, cursor: string | undefined, limit: number) {
  const rows = await db
    .select()
    .from(goals)
    .where(and(eq(goals.userId, userId), cursor ? gt(goals.id, cursor) : undefined))
    .orderBy(asc(goals.id))
    .limit(limit + 1);
  const page = rows.slice(0, limit);
  return { items: page.map(goalDto), next_cursor: rows.length > limit ? page[page.length - 1]!.id : null };
}

export async function updateGoal(
  deps: Deps,
  userId: string,
  id: string,
  input: { title?: string; description?: string | null; target_date?: string | null; status?: GoalStatus },
) {
  await getOwnedGoal(deps.database.db, userId, id);
  const [g] = await deps.database.db
    .update(goals)
    .set({
      ...(input.title !== undefined ? { title: input.title } : {}),
      ...(input.description !== undefined ? { description: input.description } : {}),
      ...(input.target_date !== undefined ? { targetDate: input.target_date } : {}),
      ...(input.status !== undefined ? { status: input.status } : {}),
      updatedAt: deps.clock.now(),
    })
    .where(eq(goals.id, id))
    .returning();
  return goalDto(g!);
}

/** Deleting a goal deletes its breakdowns; events made from it stay on the calendar, unlinked. */
export async function deleteGoal(deps: Deps, userId: string, id: string) {
  await getOwnedGoal(deps.database.db, userId, id);
  await deps.database.db.delete(goals).where(eq(goals.id, id));
}
