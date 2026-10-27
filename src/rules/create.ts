import { type GridRules, DEFAULT_GRID_RULES } from './constants.js';
import { barsBetween, isOnGrid } from './grid.js';
import { type CalendarEvent, type EventKind, findCadenzaConflicts } from './overlap.js';

export type CreateResult =
  | { ok: true }
  | { ok: false; error: 'bar_misaligned' | 'invalid_duration' }
  | { ok: false; error: 'cadenza_overlap'; conflicts: string[] };

/**
 * Validates a new or edited event block (spec §3.1, §3.6). Pass `eventId` when editing so the event
 * ignores itself. Only a Cadenza is checked for overlap.
 */
export function validateEventBlock(
  input: { calendar: readonly CalendarEvent[]; kind: EventKind; start: Date; end: Date; eventId?: string },
  rules: GridRules = DEFAULT_GRID_RULES,
): CreateResult {
  if (!isOnGrid(input.start, rules)) return { ok: false, error: 'bar_misaligned' };
  const bars = barsBetween(input.start, input.end, rules);
  if (!Number.isInteger(bars) || bars < 1) return { ok: false, error: 'invalid_duration' };
  if (input.kind === 'cadenza') {
    const conflicts = findCadenzaConflicts(input.calendar, { id: input.eventId, start: input.start, end: input.end });
    if (conflicts) return { ok: false, error: 'cadenza_overlap', conflicts };
  }
  return { ok: true };
}
