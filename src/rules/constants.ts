// Placeholder values until the game design is final (spec §3.7). The server
// reads the reward values from the versioned `reward_rules` table; these
// defaults mirror contracts/rules/fixtures.json `constants`.

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

export const DEFAULT_GRID_RULES: GridRules = Object.freeze({
  slotMinutes: 20,
  snapBeforeMinutes: 15,
  snapAfterMinutes: 5,
  maxEarlySlots: 2,
  maxOverlappingEvents: 2,
});

export const DEFAULT_REWARD_RULE: RewardRule = Object.freeze({
  tokensPerSlot: 10,
  earlySlotRate: 0.5,
  extendedSlotRate: 0.5,
  autoFinishDeductionSlots: 1,
});

export function slotMs(rules: GridRules): number {
  return rules.slotMinutes * MINUTE_MS;
}
