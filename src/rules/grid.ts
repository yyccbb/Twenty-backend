import { type GridRules, DEFAULT_GRID_RULES, MINUTE_MS, barMs } from './constants.js';

/**
 * snap(t) = the grid mark g with g − before < t ≤ g + after (spec §3.2).
 * Grid marks are UTC :00/:20/:40, which equal local marks in whole-hour zones.
 */
export function snap(t: Date, rules: GridRules = DEFAULT_GRID_RULES): Date {
  const bar = barMs(rules);
  if (rules.snapBeforeMinutes + rules.snapAfterMinutes !== rules.barMinutes) {
    throw new Error('snap window must cover exactly one bar');
  }
  const after = rules.snapAfterMinutes * MINUTE_MS;
  return new Date(Math.ceil((t.getTime() - after) / bar) * bar);
}

export function isOnGrid(t: Date, rules: GridRules = DEFAULT_GRID_RULES): boolean {
  return t.getTime() % barMs(rules) === 0;
}

/** Whole or fractional number of bars in [a, b). */
export function barsBetween(a: Date, b: Date, rules: GridRules = DEFAULT_GRID_RULES): number {
  return (b.getTime() - a.getTime()) / barMs(rules);
}

export function addBars(t: Date, bars: number, rules: GridRules = DEFAULT_GRID_RULES): Date {
  return new Date(t.getTime() + bars * barMs(rules));
}
