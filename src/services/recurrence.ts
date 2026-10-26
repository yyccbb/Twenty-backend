import rrulePkg from 'rrule';
import { AppError } from '../lib/errors.js';
import { localParts, localToUtc } from '../rules/index.js';

const { RRule } = rrulePkg;

export interface RecurrenceDef {
  dtstart: Date;
  timezone: string;
  rrule: string | null;
  /** Exclusive upper bound set when a series is split. */
  until: Date | null;
}

const DAY_MS = 86_400_000;
const MAX_OCCURRENCES = 5000;

/** Accepts "FREQ=..." or "RRULE:FREQ=...". DTSTART and TZID come from the reminder itself, not the string. */
export function normalizeRrule(input: string): string {
  const body = input.trim().replace(/^RRULE:/i, '').toUpperCase();
  if (!/(^|;)FREQ=/.test(body) || /DTSTART|TZID|\n/.test(body)) {
    throw new AppError(422, 'invalid_rrule', 'rrule must be a single RFC 5545 RRULE value with FREQ and without DTSTART');
  }
  try {
    const opts = RRule.parseString(body);
    new RRule(opts).toString();
  } catch {
    throw new AppError(422, 'invalid_rrule', 'rrule could not be parsed');
  }
  return body;
}

// rrule works on "floating" times: local wall time stored in a UTC Date. Expanding in wall time keeps
// "every day at 09:00" at 09:00 local across DST changes.
function toFloating(t: Date, tz: string): Date {
  const p = localParts(t, tz);
  return new Date(Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second));
}

function fromFloating(f: Date, tz: string): Date {
  return localToUtc(tz, f.getUTCFullYear(), f.getUTCMonth() + 1, f.getUTCDate(), f.getUTCHours(), f.getUTCMinutes());
}

function buildRule(def: RecurrenceDef) {
  const opts = RRule.parseString(def.rrule!);
  if (opts.until) opts.until = toFloating(opts.until, def.timezone);
  return new RRule({ ...opts, dtstart: toFloating(def.dtstart, def.timezone) });
}

/** Original occurrence times in [from, to), in order. */
export function expandOccurrences(def: RecurrenceDef, from: Date, to: Date): Date[] {
  const inRange = (t: Date) =>
    t.getTime() >= from.getTime() && t.getTime() < to.getTime() && (!def.until || t.getTime() < def.until.getTime());
  if (!def.rrule) return inRange(def.dtstart) ? [def.dtstart] : [];

  // Floating times can differ from real instants by up to a day; widen the window, then filter exactly.
  const fFrom = new Date(toFloating(from, def.timezone).getTime() - DAY_MS);
  const fTo = new Date(toFloating(to, def.timezone).getTime() + DAY_MS);
  const out: Date[] = [];
  buildRule(def).between(fFrom, fTo, true, (d) => {
    const t = fromFloating(d, def.timezone);
    if (inRange(t)) out.push(t);
    return out.length < MAX_OCCURRENCES;
  });
  return out;
}

export function isOccurrence(def: RecurrenceDef, at: Date): boolean {
  return expandOccurrences(def, at, new Date(at.getTime() + 1)).length === 1;
}

/** Number of occurrences strictly before `before`. */
export function countBefore(def: RecurrenceDef, before: Date): number {
  return expandOccurrences(def, def.dtstart, before).length;
}

/** Rewrites COUNT in an RRULE (or drops it when count is null). */
export function withCount(rrule: string, count: number | null): string {
  const parts = rrule.split(';').filter((p) => !p.startsWith('COUNT='));
  if (count !== null) parts.push(`COUNT=${count}`);
  return parts.join(';');
}

export function ruleCount(rrule: string): number | null {
  const m = /(?:^|;)COUNT=(\d+)/.exec(rrule);
  return m ? Number(m[1]) : null;
}
