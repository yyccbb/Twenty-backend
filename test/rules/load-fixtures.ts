import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { GridRules, RewardRule } from '../../src/rules/index.js';

// The shared fixtures come from the vendor/Twenty submodule (`git submodule update --init`).
// Set RULES_FIXTURES_PATH to test against another copy.
function findFixtures(): string {
  if (process.env.RULES_FIXTURES_PATH) return resolve(process.env.RULES_FIXTURES_PATH);
  const path = resolve(dirname(fileURLToPath(import.meta.url)), '../../vendor/Twenty/contracts/rules/fixtures.json');
  if (!existsSync(path)) {
    throw new Error('vendor/Twenty/contracts/rules/fixtures.json not found; run `git submodule update --init`');
  }
  return path;
}

export interface FixtureCase {
  id: string;
  desc: string;
  input: any;
  expected: any;
}

export interface Fixtures {
  constants: {
    slot_minutes: number;
    snap_before_minutes: number;
    snap_after_minutes: number;
    max_early_slots: number;
    max_overlapping_events: number;
    reward: {
      tokens_per_slot: number;
      early_slot_rate: number;
      extended_slot_rate: number;
      auto_finish_deduction_slots: number;
    };
  };
  groups: Record<string, FixtureCase[]>;
}

export const fixtures: Fixtures = JSON.parse(readFileSync(findFixtures(), 'utf8'));

const c = fixtures.constants;
export const gridRules: GridRules = {
  slotMinutes: c.slot_minutes,
  snapBeforeMinutes: c.snap_before_minutes,
  snapAfterMinutes: c.snap_after_minutes,
  maxEarlySlots: c.max_early_slots,
  maxOverlappingEvents: c.max_overlapping_events,
};
export const rewardRule: RewardRule = {
  tokensPerSlot: c.reward.tokens_per_slot,
  earlySlotRate: c.reward.early_slot_rate,
  extendedSlotRate: c.reward.extended_slot_rate,
  autoFinishDeductionSlots: c.reward.auto_finish_deduction_slots,
};

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;

/** Turns every time (Date or ISO string) into a canonical UTC instant string so instants compare, not strings. */
export function normalize(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'string' && ISO.test(value)) return new Date(value).toISOString();
  if (Array.isArray(value)) return value.map(normalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, normalize(v)]));
  }
  return value;
}

export const toDate = (s: string | null): Date | null => (s === null ? null : new Date(s));

export function toCalendar(list: Array<{ id: string; start: string; end: string; status?: string }>) {
  return list.map((e) => ({ id: e.id, start: new Date(e.start), end: new Date(e.end), status: e.status as any }));
}
