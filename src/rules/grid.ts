import { type GridRules, DEFAULT_GRID_RULES, MINUTE_MS, slotMs } from './constants.js';

/**
 * snap(t) = the grid mark g with g − before < t ≤ g + after (spec §3.2).
 * Grid marks are UTC :00/:20/:40, which equal local marks in whole-hour zones.
 */
export function snap(t: Date, rules: GridRules = DEFAULT_GRID_RULES): Date {
  const slot = slotMs(rules);
  if (rules.snapBeforeMinutes + rules.snapAfterMinutes !== rules.slotMinutes) {
    throw new Error('snap window must cover exactly one slot');
  }
  const after = rules.snapAfterMinutes * MINUTE_MS;
  return new Date(Math.ceil((t.getTime() - after) / slot) * slot);
}

export function isOnGrid(t: Date, rules: GridRules = DEFAULT_GRID_RULES): boolean {
  return t.getTime() % slotMs(rules) === 0;
}

/** Whole or fractional number of slots in [a, b). */
export function slotsBetween(a: Date, b: Date, rules: GridRules = DEFAULT_GRID_RULES): number {
  return (b.getTime() - a.getTime()) / slotMs(rules);
}

export function addSlots(t: Date, slots: number, rules: GridRules = DEFAULT_GRID_RULES): Date {
  return new Date(t.getTime() + slots * slotMs(rules));
}
