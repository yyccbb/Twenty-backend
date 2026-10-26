import { type GridRules, DEFAULT_GRID_RULES, MINUTE_MS, slotMs } from './constants.js';
import { type CalendarEvent, findOverlapConflicts, isActive } from './overlap.js';
import { dayEndAfter } from './timezone.js';

export interface ExtendInput {
  /** Every event near the target, using effective blocks ([recorded_start, E) for started events). */
  calendar: readonly CalendarEvent[];
  eventId: string;
  slots: number;
  now: Date;
  timezone: string;
  dayEndLocalTime: string;
}

export interface MovedEvent {
  id: string;
  start: Date;
  end: Date;
}

export type ExtendResult =
  | { ok: true; new_end: Date; moved: MovedEvent[]; day_end_warnings: string[] }
  | { ok: false; error: 'invalid_slots' | 'not_found' | 'not_in_progress' | 'window_closed' }
  | { ok: false; error: 'pushed_event_locked' | 'overlap_limit'; conflicts: string[] };

/**
 * Extends an in-progress event by whole slots and pushes later events in a cascade (spec §3.5).
 * Every pushed event shifts by the full extension; events already in progress or done can't move.
 */
export function planExtension(input: ExtendInput, rules: GridRules = DEFAULT_GRID_RULES): ExtendResult {
  if (!Number.isInteger(input.slots) || input.slots < 1) return { ok: false, error: 'invalid_slots' };
  const target = input.calendar.find((e) => e.id === input.eventId);
  if (!target) return { ok: false, error: 'not_found' };
  if (target.status !== 'in_progress') return { ok: false, error: 'not_in_progress' };

  const oldEnd = target.end.getTime();
  if (input.now.getTime() > oldEnd + rules.snapAfterMinutes * MINUTE_MS) {
    return { ok: false, error: 'window_closed' };
  }

  const delta = input.slots * slotMs(rules);
  const candidates = input.calendar.filter((e) => e.id !== target.id && isActive(e));
  const moved = new Map<string, MovedEvent>();
  const locked = new Set<string>();

  // Each moved block newly occupies [old end, old end + delta); anything starting there is pushed too.
  const ranges: Array<[number, number]> = [[oldEnd, oldEnd + delta]];
  while (ranges.length > 0) {
    const [from, to] = ranges.shift()!;
    for (const e of candidates) {
      const s = e.start.getTime();
      if (s < from || s >= to || moved.has(e.id) || locked.has(e.id)) continue;
      if (e.status === 'in_progress' || e.status === 'done') {
        locked.add(e.id);
        continue;
      }
      moved.set(e.id, { id: e.id, start: new Date(s + delta), end: new Date(e.end.getTime() + delta) });
      ranges.push([e.end.getTime(), e.end.getTime() + delta]);
    }
  }
  if (locked.size > 0) return { ok: false, error: 'pushed_event_locked', conflicts: [...locked].sort() };

  const newEnd = new Date(oldEnd + delta);
  const after: CalendarEvent[] = input.calendar.map((e) => {
    if (e.id === target.id) return { ...e, end: newEnd };
    const m = moved.get(e.id);
    return m ? { ...e, start: m.start, end: m.end } : e;
  });

  const movedList = [...moved.values()].sort(
    (a, b) => a.start.getTime() - b.start.getTime() || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
  const changed = [{ id: target.id, start: target.start, end: newEnd }, ...movedList];
  for (const subject of changed) {
    const conflicts = findOverlapConflicts(after, subject, rules.maxOverlappingEvents);
    if (conflicts) return { ok: false, error: 'overlap_limit', conflicts };
  }

  const warnings: string[] = [];
  const originalStart = new Map(input.calendar.map((e) => [e.id, e.start]));
  for (const c of changed) {
    const dayEnd = dayEndAfter(originalStart.get(c.id)!, input.timezone, input.dayEndLocalTime);
    if (c.end.getTime() > dayEnd.getTime()) warnings.push(c.id);
  }

  return { ok: true, new_end: newEnd, moved: movedList, day_end_warnings: warnings.sort() };
}
