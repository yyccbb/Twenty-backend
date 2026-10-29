import { type GridRules, DEFAULT_GRID_RULES, MAX_BARS, MINUTE_MS, barMs } from './constants.js';
import { type CalendarEvent, isActiveCadenza } from './overlap.js';
import { dayEndAfter } from './timezone.js';

export interface ExtendInput {
  /** The target and every later Cadenza, as effective blocks ([recorded_start, E) for one in progress). */
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
 * Extends an in-progress Cadenza by 1 to 72 bars and pushes later Cadenzas in a cascade (rules.md §5).
 * Each pushed Cadenza moves only as far as needed: it starts exactly at the previous one's new end,
 * so gaps are used up first. Tuttis never move. A pushed Cadenza is always still planned; if one somehow
 * isn't (a late offline start from another device), the extension is rejected rather than move its record.
 */
export function planExtension(input: ExtendInput, rules: GridRules = DEFAULT_GRID_RULES): ExtendResult {
  if (!Number.isInteger(input.bars) || input.bars < 1 || input.bars > MAX_BARS) return { ok: false, error: 'invalid_bars' };
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

  // Each changed Cadenza is checked against the first day end after its start before the push.
  const originalStart = new Map([target, ...later].map((e) => [e.id, e.start]));
  const warnings: string[] = [];
  for (const c of [{ id: target.id, end: newEnd }, ...moved]) {
    const dayEnd = dayEndAfter(originalStart.get(c.id)!, input.timezone, input.dayEndLocalTime);
    if (c.end.getTime() > dayEnd.getTime()) warnings.push(c.id);
  }

  return { ok: true, new_end: newEnd, moved, day_end_warnings: warnings.sort() };
}
