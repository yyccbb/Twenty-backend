import { type GridRules, DEFAULT_GRID_RULES } from './constants.js';
import { barsBetween, snap } from './grid.js';
import { type CalendarEvent, findCadenzaConflicts } from './overlap.js';

export type StartResult =
  | { outcome: 'rejected'; error: 'too_early' }
  | { outcome: 'rejected'; error: 'cadenza_overlap'; conflicts: string[] }
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
  /** Needed for the overlap check on an early start. */
  eventId?: string;
  calendar?: readonly CalendarEvent[];
}

/** Starts a Cadenza: recorded_start = snap(tap); the planned end never moves (spec §3.3). */
export function recordStart(input: StartInput, rules: GridRules = DEFAULT_GRID_RULES): StartResult {
  const recorded = snap(input.tappedAt, rules);
  if (recorded.getTime() >= input.plannedEnd.getTime()) return { outcome: 'missed' };

  const diff = barsBetween(recorded, input.plannedStart, rules);
  if (diff > rules.maxEarlyBars) return { outcome: 'rejected', error: 'too_early' };

  if (diff > 0 && input.calendar) {
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
