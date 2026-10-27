import { type GridRules, DEFAULT_GRID_RULES, MINUTE_MS, barMs } from './constants.js';
import { type CalendarEvent, isActiveCadenza } from './overlap.js';
import { dayEndAfter } from './timezone.js';

export interface ExtendInput {
  /** Every event near the target, using effective blocks ([recorded_start, E) for started Cadenzas). */
  calendar: readonly CalendarEvent[];
  eventId: string;
  bars: number;
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
  | { ok: false; error: 'invalid_bars' | 'not_found' | 'not_cadenza' | 'not_in_progress' | 'window_closed' }
  | { ok: false; error: 'pushed_event_locked'; conflicts: string[] };

const byStart = (a: CalendarEvent, b: CalendarEvent) =>
  a.start.getTime() - b.start.getTime() || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/**
 * Extends an in-progress Cadenza by whole bars and pushes later Cadenzas in a cascade (spec §3.5).
 * Each pushed Cadenza moves only as far as needed: it starts exactly at the previous one's new end,
 * so gaps are used up first. Tuttis never move, and Cadenzas in progress or done can't.
 */
export function planExtension(input: ExtendInput, rules: GridRules = DEFAULT_GRID_RULES): ExtendResult {
  if (!Number.isInteger(input.bars) || input.bars < 1) return { ok: false, error: 'invalid_bars' };
  const target = input.calendar.find((e) => e.id === input.eventId);
  if (!target) return { ok: false, error: 'not_found' };
  if (target.kind !== 'cadenza') return { ok: false, error: 'not_cadenza' };
  if (target.status !== 'in_progress') return { ok: false, error: 'not_in_progress' };

  const oldEnd = target.end.getTime();
  if (input.now.getTime() > oldEnd + rules.snapAfterMinutes * MINUTE_MS) {
    return { ok: false, error: 'window_closed' };
  }

  const newEnd = new Date(oldEnd + input.bars * barMs(rules));
  const later = input.calendar
    .filter((e) => e.id !== target.id && isActiveCadenza(e) && e.start.getTime() >= target.start.getTime())
    .sort(byStart);

  const moved: MovedEvent[] = [];
  const locked: string[] = [];
  let edge = newEnd.getTime();
  for (const e of later) {
    const s = e.start.getTime();
    if (s >= edge) break;
    if (e.status === 'in_progress' || e.status === 'done') locked.push(e.id);
    const end = edge + (e.end.getTime() - s);
    moved.push({ id: e.id, start: new Date(edge), end: new Date(end) });
    edge = end;
  }
  if (locked.length > 0) return { ok: false, error: 'pushed_event_locked', conflicts: locked.sort() };

  const warnings: string[] = [];
  for (const c of [{ id: target.id, start: target.start, end: newEnd }, ...moved]) {
    const originalStart = input.calendar.find((e) => e.id === c.id)!.start;
    const dayEnd = dayEndAfter(originalStart, input.timezone, input.dayEndLocalTime);
    if (c.end.getTime() > dayEnd.getTime()) warnings.push(c.id);
  }

  return { ok: true, new_end: newEnd, moved, day_end_warnings: warnings.sort() };
}
