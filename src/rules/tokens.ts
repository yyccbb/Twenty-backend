import { type GridRules, type RewardRule, DEFAULT_GRID_RULES, DEFAULT_REWARD_RULE, slotMs } from './constants.js';

export interface TokenInput {
  /** The plan as it was when the event started (before early start or extension). */
  originalStart: Date;
  originalEnd: Date;
  recordedStart: Date | null;
  recordedEnd: Date | null;
  finishKind: 'on_time' | 'shortened' | 'auto' | 'abandoned' | 'missed';
}

export interface TokenResult {
  planned_slots_completed: number;
  early_slots_completed: number;
  extended_slots_completed: number;
  auto_deduction_slots: number;
  tokens: number;
}

function overlapMs(a0: number, a1: number, b0: number, b1: number): number {
  return Math.max(0, Math.min(a1, b1) - Math.max(a0, b0));
}

/**
 * tokens = v·planned + rate_early·v·early + rate_ext·v·extended − v·deduction, floored at 0 (spec §3.7).
 * Late starts and early finishes simply complete fewer planned slots; there is no extra penalty.
 */
export function computeTokens(
  input: TokenInput,
  reward: RewardRule = DEFAULT_REWARD_RULE,
  rules: GridRules = DEFAULT_GRID_RULES,
): TokenResult {
  if (
    input.finishKind === 'abandoned' ||
    input.finishKind === 'missed' ||
    input.recordedStart === null ||
    input.recordedEnd === null
  ) {
    return {
      planned_slots_completed: 0,
      early_slots_completed: 0,
      extended_slots_completed: 0,
      auto_deduction_slots: 0,
      tokens: 0,
    };
  }
  const slot = slotMs(rules);
  const rs = input.recordedStart.getTime();
  const re = input.recordedEnd.getTime();
  const os = input.originalStart.getTime();
  const oe = input.originalEnd.getTime();

  const planned = Math.floor(overlapMs(rs, re, os, oe) / slot);
  const early = Math.floor(overlapMs(rs, re, -Infinity, os) / slot);
  const extended = Math.floor(overlapMs(rs, re, oe, Infinity) / slot);
  const deduction = input.finishKind === 'auto' ? reward.autoFinishDeductionSlots : 0;

  const v = reward.tokensPerSlot;
  const raw = v * planned + v * reward.earlySlotRate * early + v * reward.extendedSlotRate * extended - v * deduction;
  return {
    planned_slots_completed: planned,
    early_slots_completed: early,
    extended_slots_completed: extended,
    auto_deduction_slots: deduction,
    tokens: Math.max(0, Math.floor(raw)),
  };
}
