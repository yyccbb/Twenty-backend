import { z } from 'zod';
import fixtures from '../../vendor/Twenty/contracts/rules/fixtures.json' with { type: 'json' };

// Every value comes from the `constants` block of the shared fixtures in the
// vendor/Twenty submodule (placeholders until the game design is final, rules.md §7).
// The server pays out with the versioned `reward_rules` table, which migrate.ts
// keeps in step with DEFAULT_REWARD_RULE.

export const MINUTE_MS = 60_000;

/** The most bars an event may be planned with, or added by one extension: 72 bars = 24 h (rules.md §1, §5). */
export const MAX_BARS = 72;

export interface GridRules {
  barMinutes: number;
  snapBeforeMinutes: number;
  snapAfterMinutes: number;
  maxEarlyBars: number;
}

export interface RewardRule {
  tokensPerBar: number;
  earlyBarRate: number;
  extendedBarRate: number;
  autoFinishDeductionBars: number;
}

const positiveInt = z.number().int().positive();
const FixtureConstants = z.object({
  bar_minutes: positiveInt,
  snap_before_minutes: z.number().int().nonnegative(),
  snap_after_minutes: z.number().int().nonnegative(),
  max_early_bars: z.number().int().nonnegative(),
  reward: z.object({
    tokens_per_bar: positiveInt,
    early_bar_rate: z.number().nonnegative(),
    extended_bar_rate: z.number().nonnegative(),
    auto_finish_deduction_bars: z.number().int().nonnegative(),
  }),
});

const c = FixtureConstants.parse(fixtures.constants);

export const DEFAULT_GRID_RULES: GridRules = Object.freeze({
  barMinutes: c.bar_minutes,
  snapBeforeMinutes: c.snap_before_minutes,
  snapAfterMinutes: c.snap_after_minutes,
  maxEarlyBars: c.max_early_bars,
});

export const DEFAULT_REWARD_RULE: RewardRule = Object.freeze({
  tokensPerBar: c.reward.tokens_per_bar,
  earlyBarRate: c.reward.early_bar_rate,
  extendedBarRate: c.reward.extended_bar_rate,
  autoFinishDeductionBars: c.reward.auto_finish_deduction_bars,
});

export function barMs(rules: GridRules): number {
  return rules.barMinutes * MINUTE_MS;
}
