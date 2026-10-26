import { type GridRules, DEFAULT_GRID_RULES } from './constants.js';
import { isOnGrid, slotsBetween } from './grid.js';
import { type CalendarEvent, findOverlapConflicts } from './overlap.js';

export type CreateResult =
  | { ok: true }
  | { ok: false; error: 'slot_misaligned' | 'invalid_duration' }
  | { ok: false; error: 'overlap_limit'; conflicts: string[] };

/** Validates a new or rescheduled event block. Pass `eventId` when editing so the event ignores itself. */
export function validateEventBlock(
  input: { calendar: readonly CalendarEvent[]; start: Date; end: Date; eventId?: string },
  rules: GridRules = DEFAULT_GRID_RULES,
): CreateResult {
  if (!isOnGrid(input.start, rules)) return { ok: false, error: 'slot_misaligned' };
  const slots = slotsBetween(input.start, input.end, rules);
  if (!Number.isInteger(slots) || slots < 1) return { ok: false, error: 'invalid_duration' };
  const conflicts = findOverlapConflicts(
    input.calendar,
    { id: input.eventId, start: input.start, end: input.end },
    rules.maxOverlappingEvents,
  );
  if (conflicts) return { ok: false, error: 'overlap_limit', conflicts };
  return { ok: true };
}
