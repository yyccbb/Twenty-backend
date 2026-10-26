export type EventStatus = 'planned' | 'in_progress' | 'done' | 'missed' | 'cancelled';

/** An event's effective block, half-open [start, end). */
export interface CalendarEvent {
  id: string;
  start: Date;
  end: Date;
  status?: EventStatus;
}

/** Cancelled and missed events, and empty blocks, never count. */
export function isActive(e: CalendarEvent): boolean {
  return e.status !== 'cancelled' && e.status !== 'missed' && e.end.getTime() > e.start.getTime();
}

/**
 * Returns the sorted IDs of the other events that, together with `subject`,
 * exceed `maxOverlapping` at some moment, or null if the subject fits.
 */
export function findOverlapConflicts(
  calendar: readonly CalendarEvent[],
  subject: { id?: string; start: Date; end: Date },
  maxOverlapping: number,
): string[] | null {
  const s = subject.start.getTime();
  const e = subject.end.getTime();
  const others = calendar.filter(
    (c) => c.id !== subject.id && isActive(c) && c.start.getTime() < e && c.end.getTime() > s,
  );
  // The number of active events only rises at a start, so those are the only moments to check.
  const moments = [s, ...others.map((o) => o.start.getTime()).filter((t) => t > s)].sort((a, b) => a - b);
  for (const m of moments) {
    const active = others.filter((o) => o.start.getTime() <= m && o.end.getTime() > m);
    if (active.length >= maxOverlapping) {
      return active.map((o) => o.id).sort();
    }
  }
  return null;
}
