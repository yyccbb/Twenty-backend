import { z } from '@hono/zod-openapi';

const Instant = z.string().openapi({ format: 'date-time', example: '2026-11-02T06:00:00.000Z' });
const NullableInstant = Instant.nullable();

export const EventStatus = z.enum(['planned', 'in_progress', 'done', 'missed']).openapi('EventStatus');
export const FinishKind = z.enum(['on_time', 'shortened', 'auto', 'abandoned']).openapi('FinishKind');
export const EventKind = z
  .enum(['cadenza', 'tutti'])
  .openapi('EventKind', {
    description: 'cadenza: timed, rewarded focus work that never overlaps another Cadenza. tutti: an ordinary event that overlaps freely.',
  });

export const EventRecordSchema = z
  .object({
    start_tapped_at: NullableInstant,
    finish_tapped_at: NullableInstant,
    recorded_start: NullableInstant,
    recorded_end: NullableInstant,
    early_bars: z.number().int(),
    late_bars: z.number().int(),
    extended_bars: z.number().int(),
    finish_kind: FinishKind.nullable(),
    tokens_awarded: z.number().int().nullable(),
    original_planned_start: Instant,
    original_planned_end: Instant,
    rules_version: z.number().int(),
  })
  .openapi('EventRecord', { description: 'Start/finish record; Cadenzas only' });

export const EventSchema = z
  .object({
    id: z.string(),
    title: z.string(),
    notes: z.string().nullable(),
    goal_id: z.string().nullable(),
    breakdown_item_id: z.string().nullable(),
    planned_start: Instant,
    planned_end: Instant,
    kind: EventKind,
    duration_bars: z.number().int(),
    status: EventStatus.openapi({ description: 'Tuttis are only ever planned' }),
    version: z.number().int(),
    record: EventRecordSchema.nullable(),
    created_at: Instant,
    updated_at: Instant,
  })
  .openapi('Event');

export const EventPage = z.object({ items: z.array(EventSchema), next_cursor: z.string().nullable() }).openapi('EventPage');

export const StartResultSchema = z
  .object({
    outcome: z.enum(['early', 'on_time', 'late', 'missed']),
    recorded_start: NullableInstant,
    early_bars: z.number().int(),
    late_bars: z.number().int(),
    event: EventSchema,
  })
  .openapi('StartResult');

export const ExtendResultSchema = z
  .object({
    dry_run: z.boolean(),
    new_end: Instant,
    moved: z
      .array(z.object({ id: z.string(), planned_start: Instant, planned_end: Instant, version: z.number().int() }))
      .openapi({ description: 'Every Cadenza the cascade pushes, in start order' }),
    day_end_warnings: z.array(z.string()).openapi({ description: 'IDs of changed Cadenzas that now end after the day end' }),
    event: EventSchema,
  })
  .openapi('ExtendResult');

export const TokenBreakdownSchema = z
  .object({
    planned_bars_completed: z.number().int(),
    early_bars_completed: z.number().int(),
    extended_bars_completed: z.number().int(),
    auto_deduction_bars: z.number().int(),
    tokens: z.number().int(),
  })
  .openapi('TokenBreakdown');

export const FinishResultSchema = z
  .object({
    finish_kind: FinishKind,
    recorded_end: NullableInstant,
    tokens: TokenBreakdownSchema,
    tokens_awarded: z.number().int(),
    token_balance: z.number().int(),
    event: EventSchema,
  })
  .openapi('FinishResult');

export const PlanningPrompt = z
  .object({
    weekday: z.array(z.number().int().min(1).max(7)).min(1).openapi({ description: 'ISO weekdays, 1 = Monday' }),
    local_time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
  })
  .openapi('PlanningPrompt');

export const MeSchema = z
  .object({
    id: z.string(),
    display_name: z.string().nullable(),
    email: z.string().nullable().openapi({ description: 'Set for email accounts; null for Sign in with Apple' }),
    timezone: z.string(),
    timezone_supported: z.boolean(),
    token_balance: z.number().int(),
    created_at: Instant,
    settings: z.object({
      planning_prompts: z.array(PlanningPrompt),
      day_end_local_time: z.string(),
      preferences: z.record(z.string(), z.unknown()),
    }),
  })
  .openapi('Me');

export const SessionSchema = z
  .object({
    access_token: z.string(),
    token_type: z.literal('Bearer'),
    expires_in: z.number().int(),
    refresh_token: z.string(),
    refresh_expires_at: Instant,
    user_id: z.string(),
  })
  .openapi('Session');

export const CueSchema = z
  .object({
    id: z.string(),
    series_id: z.string(),
    title: z.string(),
    notes: z.string().nullable(),
    at: Instant.openapi({ description: 'First occurrence (DTSTART)' }),
    timezone: z.string(),
    rrule: z.string().nullable().openapi({ example: 'FREQ=MONTHLY;BYDAY=2TU' }),
    until: NullableInstant.openapi({ description: 'Exclusive end, set when the series was split' }),
    version: z.number().int(),
    created_at: Instant,
    updated_at: Instant,
  })
  .openapi('Cue');

export const OccurrenceStatus = z.enum(['pending', 'done', 'skipped', 'snoozed', 'moved']).openapi('OccurrenceStatus');

export const OccurrenceSchema = z
  .object({
    cue_id: z.string(),
    series_id: z.string(),
    title: z.string(),
    notes: z.string().nullable(),
    original_at: Instant,
    at: Instant.openapi({ description: 'When it fires: new_at if moved or snoozed, else original_at' }),
    status: OccurrenceStatus,
    repeating: z.boolean(),
  })
  .openapi('CueOccurrence');

export const GoalSchema = z
  .object({
    id: z.string(),
    title: z.string(),
    description: z.string().nullable(),
    target_date: z.string().nullable().openapi({ format: 'date' }),
    status: z.enum(['active', 'achieved', 'archived']),
    created_at: Instant,
    updated_at: Instant,
  })
  .openapi('Goal');

export const BreakdownItemSchema = z
  .object({
    id: z.string(),
    title: z.string(),
    description: z.string().nullable(),
    duration_bars: z.number().int(),
    sessions_per_week: z.number().int().nullable(),
  })
  .openapi('BreakdownItem');

export const BreakdownSchema = z
  .object({
    id: z.string(),
    goal_id: z.string(),
    status: z.enum(['queued', 'running', 'done', 'failed']),
    model: z.string().nullable(),
    prompt_version: z.string(),
    summary: z.string().nullable(),
    items: z.array(BreakdownItemSchema).nullable(),
    error: z.string().nullable(),
    created_at: Instant,
    updated_at: Instant,
  })
  .openapi('Breakdown');

export const LedgerEntrySchema = z
  .object({
    id: z.string(),
    delta: z.number().int(),
    reason: z.enum(['event_reward', 'badge_redeem', 'adjustment']),
    ref_id: z.string().nullable(),
    rules_version: z.number().int().nullable(),
    created_at: Instant,
  })
  .openapi('LedgerEntry');

export const BadgeSchema = z
  .object({
    id: z.string(),
    code: z.string(),
    name: z.string(),
    description: z.string().nullable(),
    cost: z.number().int(),
    image_url: z.string().nullable(),
    active: z.boolean(),
    owned: z.boolean(),
    acquired_at: NullableInstant,
  })
  .openapi('Badge');
