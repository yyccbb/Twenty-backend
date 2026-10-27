export type EventStatus = 'planned' | 'in_progress' | 'done' | 'missed' | 'cancelled';
export type EventKind = 'cadenza' | 'tutti';

/** An event's effective block, half-open [start, end). */
export interface CalendarEvent {
  id: string;
  kind: EventKind;
  start: Date;
  end: Date;
  status?: EventStatus;
}

/** Cancelled and missed events, and empty blocks, never count. */
export function isActive(e: CalendarEvent): boolean {
  return e.status !== 'cancelled' && e.status !== 'missed' && e.end.getTime() > e.start.getTime();
}

/** Active Cadenzas are the only events the overlap rule and the cascade look at (spec §3.6). */
export function isActiveCadenza(e: CalendarEvent): boolean {
  return e.kind === 'cadenza' && isActive(e);
}

/**
 * Returns the sorted IDs of the other Cadenzas that `subject` (a Cadenza block) would overlap,
 * or null if it fits. Tuttis overlap anything.
 */
export function findCadenzaConflicts(
  calendar: readonly CalendarEvent[],
  subject: { id?: string; start: Date; end: Date },
): string[] | null {
  const s = subject.start.getTime();
  const e = subject.end.getTime();
  const conflicts = calendar
    .filter((c) => c.id !== subject.id && isActiveCadenza(c) && c.start.getTime() < e && c.end.getTime() > s)
    .map((c) => c.id)
    .sort();
  return conflicts.length > 0 ? conflicts : null;
}
