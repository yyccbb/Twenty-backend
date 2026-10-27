import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  date,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  time,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

const ts = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });
const createdAt = () => ts('created_at').notNull().defaultNow();
const updatedAt = () => ts('updated_at').notNull().defaultNow();

export const eventStatus = pgEnum('event_status', ['planned', 'in_progress', 'done', 'missed', 'cancelled']);
export const eventKind = pgEnum('event_kind', ['cadenza', 'tutti']);
export const finishKind = pgEnum('finish_kind', ['on_time', 'shortened', 'auto', 'abandoned']);
export const eventChangeKind = pgEnum('event_change_kind', ['extend', 'cascade_shift', 'early_start']);
export const goalStatus = pgEnum('goal_status', ['active', 'achieved', 'archived']);
export const breakdownStatus = pgEnum('breakdown_status', ['queued', 'running', 'done', 'failed']);
// `cancelled` (one occurrence deleted) is an addition to the spec's done|skipped|snoozed|moved.
export const occurrenceStatus = pgEnum('occurrence_status', ['done', 'skipped', 'snoozed', 'moved', 'cancelled']);
export const ledgerReason = pgEnum('ledger_reason', ['event_reward', 'badge_redeem', 'adjustment']);

export const users = pgTable('users', {
  id: uuid('id').primaryKey(),
  // Nulled on account deletion so the Apple ID can sign up again as a new user.
  appleSub: text('apple_sub').unique(),
  // Lower-cased and trimmed. Nulled with password_hash on account deletion, like apple_sub.
  email: text('email').unique(),
  passwordHash: text('password_hash'),
  displayName: text('display_name'),
  timezone: text('timezone').notNull().default('UTC'),
  tokenBalance: integer('token_balance').notNull().default(0),
  createdAt: createdAt(),
  deletedAt: ts('deleted_at'),
});

export const refreshTokens = pgTable(
  'refresh_tokens',
  {
    id: uuid('id').primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull().unique(),
    deviceLabel: text('device_label'),
    createdAt: createdAt(),
    expiresAt: ts('expires_at').notNull(),
    revokedAt: ts('revoked_at'),
    replacedById: uuid('replaced_by_id'),
  },
  (t) => [index('refresh_tokens_user_idx').on(t.userId)],
);

export const userSettings = pgTable('user_settings', {
  userId: uuid('user_id')
    .primaryKey()
    .references(() => users.id, { onDelete: 'cascade' }),
  planningPrompts: jsonb('planning_prompts')
    .$type<Array<{ weekday: number[]; local_time: string }>>()
    .notNull()
    .default(sql`'[]'::jsonb`),
  dayEndLocalTime: time('day_end_local_time').notNull().default('00:00'),
  preferences: jsonb('preferences').$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
  updatedAt: updatedAt(),
});

export const goals = pgTable(
  'goals',
  {
    id: uuid('id').primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    title: text('title').notNull(),
    description: text('description'),
    targetDate: date('target_date', { mode: 'string' }),
    status: goalStatus('status').notNull().default('active'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('goals_user_idx').on(t.userId, t.id)],
);

export interface BreakdownItem {
  id: string;
  title: string;
  description: string | null;
  duration_bars: number;
  sessions_per_week: number | null;
}

export const aiBreakdowns = pgTable(
  'ai_breakdowns',
  {
    id: uuid('id').primaryKey(),
    goalId: uuid('goal_id')
      .notNull()
      .references(() => goals.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    status: breakdownStatus('status').notNull().default('queued'),
    model: text('model'),
    promptVersion: text('prompt_version').notNull(),
    request: jsonb('request').$type<{ hints: string | null; max_items: number }>().notNull(),
    result: jsonb('result').$type<{ summary: string | null; items: BreakdownItem[] }>(),
    error: text('error'),
    tokensUsed: integer('tokens_used'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('ai_breakdowns_user_created_idx').on(t.userId, t.createdAt)],
);

export const events = pgTable(
  'events',
  {
    id: uuid('id').primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    title: text('title').notNull(),
    notes: text('notes'),
    goalId: uuid('goal_id').references(() => goals.id, { onDelete: 'set null' }),
    breakdownItemId: uuid('breakdown_item_id'),
    plannedStart: ts('planned_start').notNull(),
    kind: eventKind('kind').notNull().default('cadenza'),
    durationBars: integer('duration_bars').notNull(),
    status: eventStatus('status').notNull().default('planned'),
    version: integer('version').notNull().default(1),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('events_user_planned_start_idx').on(t.userId, t.plannedStart),
    index('events_status_idx').on(t.status, t.plannedStart),
    check('events_duration_positive', sql`${t.durationBars} >= 1`),
    // Tuttis are never started, so they are only ever planned or cancelled (spec §4).
    check('events_tutti_status', sql`${t.kind} = 'cadenza' OR ${t.status} IN ('planned', 'cancelled')`),
    check('events_start_on_grid', sql`(extract(epoch from ${t.plannedStart})::bigint % 1200) = 0`),
  ],
);

// Cadenzas only.
export const eventRecords = pgTable('event_records', {
  eventId: uuid('event_id')
    .primaryKey()
    .references(() => events.id, { onDelete: 'cascade' }),
  // Raw device times.
  startTappedAt: ts('start_tapped_at'),
  finishTappedAt: ts('finish_tapped_at'),
  // Computed by the server.
  recordedStart: ts('recorded_start'),
  recordedEnd: ts('recorded_end'),
  lateBars: integer('late_bars').notNull().default(0),
  earlyBars: integer('early_bars').notNull().default(0),
  extendedBars: integer('extended_bars').notNull().default(0),
  finishKind: finishKind('finish_kind'),
  tokensAwarded: integer('tokens_awarded'),
  // The plan before early start / extend / shift.
  originalPlannedStart: ts('original_planned_start').notNull(),
  originalPlannedEnd: ts('original_planned_end').notNull(),
  rulesVersion: integer('rules_version').notNull(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const eventChanges = pgTable(
  'event_changes',
  {
    id: uuid('id').primaryKey(),
    eventId: uuid('event_id')
      .notNull()
      .references(() => events.id, { onDelete: 'cascade' }),
    kind: eventChangeKind('kind').notNull(),
    deltaBars: integer('delta_bars').notNull(),
    causedByEventId: uuid('caused_by_event_id'),
    createdAt: createdAt(),
  },
  (t) => [index('event_changes_event_idx').on(t.eventId)],
);

export const cues = pgTable(
  'cues',
  {
    id: uuid('id').primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    seriesId: uuid('series_id').notNull(),
    title: text('title').notNull(),
    notes: text('notes'),
    dtstart: ts('dtstart').notNull(),
    timezone: text('timezone').notNull(),
    rrule: text('rrule'),
    // Exclusive: occurrences at or after `until` don't exist. Set when a series is split.
    until: ts('until'),
    version: integer('version').notNull().default(1),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('cues_user_idx').on(t.userId, t.id), index('cues_series_idx').on(t.seriesId)],
);

export const cueOccurrences = pgTable(
  'cue_occurrences',
  {
    cueId: uuid('cue_id')
      .notNull()
      .references(() => cues.id, { onDelete: 'cascade' }),
    originalAt: ts('original_at').notNull(),
    status: occurrenceStatus('status').notNull(),
    newAt: ts('new_at'),
    // Set when "this occurrence" was edited into a standalone copy.
    detachedCueId: uuid('detached_cue_id'),
    updatedAt: updatedAt(),
  },
  (t) => [primaryKey({ columns: [t.cueId, t.originalAt] }), index('cue_occurrences_new_at_idx').on(t.newAt)],
);

export const rewardRules = pgTable(
  'reward_rules',
  {
    version: integer('version').primaryKey(),
    tokensPerBar: integer('tokens_per_bar').notNull(),
    earlyBarRate: numeric('early_bar_rate', { precision: 5, scale: 4, mode: 'number' }).notNull(),
    extendedBarRate: numeric('extended_bar_rate', { precision: 5, scale: 4, mode: 'number' }).notNull(),
    autoFinishDeductionBars: integer('auto_finish_deduction_bars').notNull(),
    createdAt: createdAt(),
  },
  (t) => [check('reward_rules_even_value', sql`${t.tokensPerBar} > 0 AND ${t.tokensPerBar} % 2 = 0`)],
);

// Append-only: a trigger (see migrations) rejects UPDATE, DELETE and TRUNCATE.
export const tokenLedger = pgTable(
  'token_ledger',
  {
    id: uuid('id').primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    delta: integer('delta').notNull(),
    reason: ledgerReason('reason').notNull(),
    refId: uuid('ref_id'),
    rulesVersion: integer('rules_version'),
    idempotencyKey: text('idempotency_key').notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('token_ledger_idempotency_key_uq').on(t.idempotencyKey),
    index('token_ledger_user_created_idx').on(t.userId, t.createdAt),
  ],
);

export const badges = pgTable(
  'badges',
  {
    id: uuid('id').primaryKey(),
    code: text('code').notNull().unique(),
    name: text('name').notNull(),
    description: text('description'),
    cost: integer('cost').notNull(),
    imageUrl: text('image_url'),
    active: boolean('active').notNull().default(true),
    createdAt: createdAt(),
  },
  (t) => [check('badges_cost_non_negative', sql`${t.cost} >= 0`)],
);

export const userBadges = pgTable(
  'user_badges',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    badgeId: uuid('badge_id')
      .notNull()
      .references(() => badges.id),
    ledgerEntryId: uuid('ledger_entry_id')
      .notNull()
      .references(() => tokenLedger.id),
    acquiredAt: ts('acquired_at').notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.badgeId] })],
);

// HTTP Idempotency-Key replay store. Rows expire after 24 h (maintenance job).
export const idempotencyKeys = pgTable(
  'idempotency_keys',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    key: text('key').notNull(),
    method: text('method').notNull(),
    path: text('path').notNull(),
    requestHash: text('request_hash').notNull(),
    statusCode: integer('status_code'),
    responseBody: text('response_body'),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.key] }), index('idempotency_keys_created_idx').on(t.createdAt)],
);
