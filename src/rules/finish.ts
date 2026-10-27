import { type GridRules, DEFAULT_GRID_RULES, MINUTE_MS, barMs } from './constants.js';
import { snap } from './grid.js';

export type FinishKind = 'on_time' | 'shortened' | 'auto' | 'abandoned';

export type FinishResult =
  | { finish_kind: 'on_time' | 'shortened' | 'auto'; recorded_end: Date }
  | { finish_kind: 'abandoned' };

export interface FinishInput {
  recordedStart: Date;
  /** E: the current planned end, after any extension. */
  plannedEnd: Date;
  /** null means the auto-finish job fired at E + grace. */
  tappedAt: Date | null;
}

/**
 * Spec §3.4. Finish taps snap like start taps, with one exception at the end: on time is only (E − grace, E + grace],
 * so a tap that snaps to E from further before it loses the last bar. A tap after E + grace (e.g. a queued
 * offline tap) counts as auto-finish.
 */
export function recordFinish(input: FinishInput, rules: GridRules = DEFAULT_GRID_RULES): FinishResult {
  const end = input.plannedEnd.getTime();
  const grace = rules.snapAfterMinutes * MINUTE_MS;
  if (input.tappedAt === null || input.tappedAt.getTime() > end + grace) {
    return { finish_kind: 'auto', recorded_end: new Date(end) };
  }
  let snapped = snap(input.tappedAt, rules);
  // The end exception: snapping up to E only counts within the grace before it.
  if (snapped.getTime() >= end && input.tappedAt.getTime() <= end - grace) snapped = new Date(end - barMs(rules));
  if (snapped.getTime() <= input.recordedStart.getTime()) return { finish_kind: 'abandoned' };
  if (snapped.getTime() >= end) return { finish_kind: 'on_time', recorded_end: new Date(end) };
  return { finish_kind: 'shortened', recorded_end: snapped };
}
