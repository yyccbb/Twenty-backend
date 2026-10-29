import { type GridRules, DEFAULT_GRID_RULES } from './constants.js';
import { barsBetween, snap } from './grid.js';
import { type CalendarEvent, findCadenzaConflicts } from './overlap.js';

export type StartResult =
  | { outcome: 'rejected'; error: 'too_early' }
  | { outcome: 'rejected'; error: 'cadenza_in_progress' | 'cadenza_overlap'; conflicts: string[] }
  | { outcome: 'missed' }
  | {
      outcome: 'early' | 'on_time' | 'late';
      recorded_start: Date;
      early_bars: number;
      late_bars: number;
    };

export interface StartInput {
  plannedStart: Date;
  plannedEnd: Date;
  tappedAt: Date;
  /** The Cadenza being started, so it is left out of its own checks. */
  eventId?: string;
  /** The user's other Cadenzas: any in progress, and those an early start could reach. */
  calendar: readonly CalendarEvent[];
}

/**
 * Starts a Cadenza (rules.md §3): recorded_start = snap(tap) and the planned end never moves. Up to 2 bars early
 * is allowed if the longer block overlaps no other Cadenza, and only while no other Cadenza is in progress.
 */
export function recordStart(input: StartInput, rules: GridRules = DEFAULT_GRID_RULES): StartResult {
  const recorded = snap(input.tappedAt, rules);
  if (recorded.getTime() >= input.plannedEnd.getTime()) return { outcome: 'missed' };

  const diff = barsBetween(recorded, input.plannedStart, rules);
  if (diff > rules.maxEarlyBars) return { outcome: 'rejected', error: 'too_early' };

  const running = input.calendar
    .filter((e) => e.id !== input.eventId && e.kind === 'cadenza' && e.status === 'in_progress')
    .map((e) => e.id)
    .sort();
  if (running.length > 0) return { outcome: 'rejected', error: 'cadenza_in_progress', conflicts: running };

  if (diff > 0) {
    const conflicts = findCadenzaConflicts(input.calendar, { id: input.eventId, start: recorded, end: input.plannedEnd });
    if (conflicts) return { outcome: 'rejected', error: 'cadenza_overlap', conflicts };
  }

  return {
    outcome: diff > 0 ? 'early' : diff < 0 ? 'late' : 'on_time',
    recorded_start: recorded,
    early_bars: Math.max(diff, 0),
    late_bars: Math.max(-diff, 0),
  };
}
