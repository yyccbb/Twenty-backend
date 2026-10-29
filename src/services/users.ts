import { and, eq, isNull } from 'drizzle-orm';
import { type Db, lockUser, transaction } from '../db/client.js';
import {
  events,
  goals,
  idempotencyKeys,
  refreshTokens,
  cues,
  userBadges,
  userSettings,
  users,
} from '../db/schema.js';
import type { Deps } from '../deps.js';
import { AppError, notFound } from '../lib/errors.js';
import { hhmm, iso } from '../lib/time.js';
import { isSupportedTimezone, isValidTimezone } from '../rules/index.js';

export interface UserContext {
  timezone: string;
  dayEndLocalTime: string;
}

export function assertSupportedTimezone(tz: string): void {
  if (!isValidTimezone(tz)) throw new AppError(422, 'invalid_timezone', `${tz} is not an IANA time zone`);
  if (!isSupportedTimezone(tz)) {
    throw new AppError(
      422,
      'unsupported_timezone',
      `${tz} is not a whole-hour UTC offset; only whole-hour time zones are supported for now`,
    );
  }
}

export async function getUserContext(db: Db, userId: string): Promise<UserContext> {
  const [row] = await db
    .select({ timezone: users.timezone, dayEnd: userSettings.dayEndLocalTime })
    .from(users)
    .leftJoin(userSettings, eq(userSettings.userId, users.id))
    .where(eq(users.id, userId));
  if (!row) throw notFound('User');
  return { timezone: row.timezone, dayEndLocalTime: hhmm(row.dayEnd ?? '00:00') };
}

export async function getMe(db: Db, userId: string) {
  const [row] = await db
    .select({ user: users, settings: userSettings })
    .from(users)
    .leftJoin(userSettings, eq(userSettings.userId, users.id))
    .where(and(eq(users.id, userId), isNull(users.deletedAt)));
  if (!row) throw notFound('User');
  const { user, settings } = row;
  return {
    id: user.id,
    display_name: user.displayName,
    email: user.email,
    timezone: user.timezone,
    timezone_supported: isSupportedTimezone(user.timezone),
    token_balance: user.tokenBalance,
    created_at: iso(user.createdAt),
    settings: {
      planning_prompts: settings?.planningPrompts ?? [],
      day_end_local_time: hhmm(settings?.dayEndLocalTime ?? '00:00'),
      preferences: settings?.preferences ?? {},
    },
  };
}

export interface SettingsPatch {
  display_name?: string | null;
  timezone?: string;
  planning_prompts?: Array<{ weekday: number[]; local_time: string }>;
  day_end_local_time?: string;
  preferences?: Record<string, unknown>;
}

export async function updateSettings(deps: Deps, userId: string, patch: SettingsPatch) {
  if (patch.timezone !== undefined) assertSupportedTimezone(patch.timezone);
  await transaction(deps.database, async (tx) => {
    if (patch.timezone !== undefined || patch.display_name !== undefined) {
      await tx.db
        .update(users)
        .set({
          ...(patch.timezone !== undefined ? { timezone: patch.timezone } : {}),
          ...(patch.display_name !== undefined ? { displayName: patch.display_name } : {}),
        })
        .where(eq(users.id, userId));
    }
    const settings = {
      ...(patch.planning_prompts !== undefined ? { planningPrompts: patch.planning_prompts } : {}),
      ...(patch.day_end_local_time !== undefined ? { dayEndLocalTime: patch.day_end_local_time } : {}),
      ...(patch.preferences !== undefined ? { preferences: patch.preferences } : {}),
    };
    if (Object.keys(settings).length > 0) {
      await tx.db
        .insert(userSettings)
        .values({ userId, ...settings })
        .onConflictDoUpdate({ target: userSettings.userId, set: { ...settings, updatedAt: deps.clock.now() } });
    }
  });
  return getMe(deps.database.db, userId);
}

/**
 * App Store account deletion. Personal data is deleted; the user row is kept, stripped of identifying
 * fields, because the append-only token ledger references it. The Apple ID or email can then sign up again.
 */
export async function deleteAccount(deps: Deps, userId: string): Promise<void> {
  await transaction(deps.database, async (tx) => {
    await lockUser(tx, userId);
    await tx.db.delete(events).where(eq(events.userId, userId));
    await tx.db.delete(cues).where(eq(cues.userId, userId));
    await tx.db.delete(goals).where(eq(goals.userId, userId));
    await tx.db.delete(userBadges).where(eq(userBadges.userId, userId));
    await tx.db.delete(userSettings).where(eq(userSettings.userId, userId));
    await tx.db.delete(refreshTokens).where(eq(refreshTokens.userId, userId));
    await tx.db.delete(idempotencyKeys).where(eq(idempotencyKeys.userId, userId));
    await tx.db
      .update(users)
      .set({ appleSub: null, email: null, passwordHash: null, displayName: null, deletedAt: deps.clock.now() })
      .where(eq(users.id, userId));
  });
}
