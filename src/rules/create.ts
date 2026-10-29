import { type GridRules, DEFAULT_GRID_RULES, MAX_BARS } from './constants.js';
import { barsBetween, isOnGrid } from './grid.js';
import { type CalendarEvent, type EventKind, findCadenzaConflicts } from './overlap.js';

export type CreateResult =
  | { ok: true }
  | { ok: false; error: 'bar_misaligned' | 'invalid_duration' | 'start_in_past' }
  | { ok: false; error: 'cadenza_overlap'; conflicts: string[] };

export interface BlockInput {
  calendar: readonly CalendarEvent[];
  kind: EventKind;
  start: Date;
  end: Date;
  /** The event being edited; its current block must be in `calendar`. */
  eventId?: string;
  /** The server's clock. Without it the past check is skipped. */
  now?: Date;
}

/**
 * Validates a new or edited event block (rules.md §1, §6): on the grid, 1 to 72 bars and, for a Cadenza,
 * not starting before `now` and not overlapping another Cadenza. The past check runs whenever a Cadenza's
 * start is set (create, a move, a switch from Tutti); an edit that keeps a Cadenza's start isn't checked.
 */
export function validateEventBlock(input: BlockInput, rules: GridRules = DEFAULT_GRID_RULES): CreateResult {
  if (!isOnGrid(input.start, rules)) return { ok: false, error: 'bar_misaligned' };
  const bars = barsBetween(input.start, input.end, rules);
  if (!Number.isInteger(bars) || bars < 1 || bars > MAX_BARS) return { ok: false, error: 'invalid_duration' };
  if (input.kind !== 'cadenza') return { ok: true };

  if (input.now && input.start.getTime() < input.now.getTime()) {
    const current = input.calendar.find((e) => e.id === input.eventId);
    if (current?.kind !== 'cadenza' || current.start.getTime() !== input.start.getTime()) {
      return { ok: false, error: 'start_in_past' };
    }
  }
  const conflicts = findCadenzaConflicts(input.calendar, { id: input.eventId, start: input.start, end: input.end });
  return conflicts ? { ok: false, error: 'cadenza_overlap', conflicts } : { ok: true };
}
