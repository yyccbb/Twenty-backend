import { z } from 'zod';
import fixtures from '../../vendor/Twenty/contracts/rules/fixtures.json' with { type: 'json' };

// Every value comes from the `constants` block of the shared fixtures in the
// vendor/Twenty submodule (placeholders until the game design is final, spec §3.7).
// The server pays out with the versioned `reward_rules` table, which migrate.ts
// keeps in step with DEFAULT_REWARD_RULE.

export const MINUTE_MS = 60_000;

export interface GridRules {
  slotMinutes: number;
  snapBeforeMinutes: number;
  snapAfterMinutes: number;
  maxEarlySlots: number;
  maxOverlappingEvents: number;
}

export interface RewardRule {
  tokensPerSlot: number;
  earlySlotRate: number;
  extendedSlotRate: number;
  autoFinishDeductionSlots: number;
}

const positiveInt = z.number().int().positive();
const FixtureConstants = z.object({
  slot_minutes: positiveInt,
  snap_before_minutes: z.number().int().nonnegative(),
  snap_after_minutes: z.number().int().nonnegative(),
  max_early_slots: z.number().int().nonnegative(),
  max_overlapping_events: positiveInt,
  reward: z.object({
    tokens_per_slot: positiveInt,
    early_slot_rate: z.number().nonnegative(),
    extended_slot_rate: z.number().nonnegative(),
    auto_finish_deduction_slots: z.number().int().nonnegative(),
  }),
});

const c = FixtureConstants.parse(fixtures.constants);

export const DEFAULT_GRID_RULES: GridRules = Object.freeze({
  slotMinutes: c.slot_minutes,
  snapBeforeMinutes: c.snap_before_minutes,
  snapAfterMinutes: c.snap_after_minutes,
  maxEarlySlots: c.max_early_slots,
  maxOverlappingEvents: c.max_overlapping_events,
});

export const DEFAULT_REWARD_RULE: RewardRule = Object.freeze({
  tokensPerSlot: c.reward.tokens_per_slot,
  earlySlotRate: c.reward.early_slot_rate,
  extendedSlotRate: c.reward.extended_slot_rate,
  autoFinishDeductionSlots: c.reward.auto_finish_deduction_slots,
});

export function slotMs(rules: GridRules): number {
  return rules.slotMinutes * MINUTE_MS;
}
