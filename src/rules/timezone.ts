import { MINUTE_MS } from './constants.js';

// Pure time-zone helpers built on the runtime's IANA database (Intl). No clock access.

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(tz: string): Intl.DateTimeFormat {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    formatters.set(tz, f);
  }
  return f;
}

export interface LocalParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

export function isValidTimezone(tz: string): boolean {
  try {
    formatter(tz);
    return true;
  } catch {
    return false;
  }
}

export function localParts(t: Date, tz: string): LocalParts {
  const parts: Record<string, number> = {};
  for (const p of formatter(tz).formatToParts(t)) {
    if (p.type !== 'literal') parts[p.type] = Number(p.value);
  }
  return {
    year: parts.year!,
    month: parts.month!,
    day: parts.day!,
    hour: parts.hour!,
    minute: parts.minute!,
    second: parts.second!,
  };
}

/** UTC offset of `tz` at instant `t`, in minutes (e.g. +480 for Asia/Shanghai). */
export function utcOffsetMinutes(t: Date, tz: string): number {
  const p = localParts(t, tz);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  const truncated = Math.floor(t.getTime() / 1000) * 1000;
  return Math.round((asUtc - truncated) / MINUTE_MS);
}

/** The instant at which the wall clock in `tz` shows the given local time. Day/month overflow is normalised. */
export function localToUtc(tz: string, year: number, month: number, day: number, hour: number, minute: number): Date {
  const wall = Date.UTC(year, month - 1, day, hour, minute);
  const first = wall - utcOffsetMinutes(new Date(wall), tz) * MINUTE_MS;
  const second = wall - utcOffsetMinutes(new Date(first), tz) * MINUTE_MS;
  return new Date(second);
}

const supportCache = new Map<string, boolean>();
// Fixed sample window so the answer never depends on the current date.
const SAMPLE_FROM = Date.UTC(2020, 0, 1);
const SAMPLE_TO = Date.UTC(2036, 0, 1);
const SAMPLE_STEP = 24 * 60 * MINUTE_MS;

/**
 * Only zones whose offset is always a whole number of hours are supported (spec §3.1),
 * because grid math runs in UTC.
 */
export function isSupportedTimezone(tz: string): boolean {
  const cached = supportCache.get(tz);
  if (cached !== undefined) return cached;
  let supported = isValidTimezone(tz);
  for (let t = SAMPLE_FROM; supported && t < SAMPLE_TO; t += SAMPLE_STEP) {
    if (utcOffsetMinutes(new Date(t), tz) % 60 !== 0) supported = false;
  }
  supportCache.set(tz, supported);
  return supported;
}

/** Parses "HH:MM" (00:00–23:59). */
export function parseLocalTime(value: string): { hour: number; minute: number } {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(value);
  if (!m) throw new Error(`invalid local time: ${value}`);
  return { hour: Number(m[1]), minute: Number(m[2]) };
}

/**
 * The end of the user's day that an event starting at `start` belongs to: the first instant
 * strictly after `start` at which the local clock reads `dayEndLocalTime` (spec §3.5).
 */
export function dayEndAfter(start: Date, tz: string, dayEndLocalTime: string): Date {
  const { hour, minute } = parseLocalTime(dayEndLocalTime);
  const p = localParts(start, tz);
  const sameDay = localToUtc(tz, p.year, p.month, p.day, hour, minute);
  if (sameDay.getTime() > start.getTime()) return sameDay;
  return localToUtc(tz, p.year, p.month, p.day + 1, hour, minute);
}
