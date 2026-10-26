import { type GridRules, DEFAULT_GRID_RULES } from './constants.js';
import { slotsBetween, snap } from './grid.js';
import { type CalendarEvent, findOverlapConflicts } from './overlap.js';

export type StartResult =
  | { outcome: 'rejected'; error: 'too_early' }
  | { outcome: 'rejected'; error: 'overlap_limit'; conflicts: string[] }
  | { outcome: 'missed' }
  | {
      outcome: 'early' | 'on_time' | 'late';
      recorded_start: Date;
      early_slots: number;
      late_slots: number;
    };

export interface StartInput {
  plannedStart: Date;
  plannedEnd: Date;
  tappedAt: Date;
  /** Needed for the overlap check on an early start. */
  eventId?: string;
  calendar?: readonly CalendarEvent[];
}

/** recorded_start = snap(tap); the planned end never moves (spec §3.3). */
export function recordStart(input: StartInput, rules: GridRules = DEFAULT_GRID_RULES): StartResult {
  const recorded = snap(input.tappedAt, rules);
  if (recorded.getTime() >= input.plannedEnd.getTime()) return { outcome: 'missed' };

  const diff = slotsBetween(recorded, input.plannedStart, rules);
  if (diff > rules.maxEarlySlots) return { outcome: 'rejected', error: 'too_early' };

  if (diff > 0 && input.calendar) {
    const conflicts = findOverlapConflicts(
      input.calendar,
      { id: input.eventId, start: recorded, end: input.plannedEnd },
      rules.maxOverlappingEvents,
    );
    if (conflicts) return { outcome: 'rejected', error: 'overlap_limit', conflicts };
  }

  return {
    outcome: diff > 0 ? 'early' : diff < 0 ? 'late' : 'on_time',
    recorded_start: recorded,
    early_slots: Math.max(diff, 0),
    late_slots: Math.max(-diff, 0),
  };
}
