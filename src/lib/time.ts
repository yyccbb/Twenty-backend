export const iso = (d: Date) => d.toISOString();
export const isoOrNull = (d: Date | null | undefined) => (d ? d.toISOString() : null);
export const addMinutes = (d: Date, minutes: number) => new Date(d.getTime() + minutes * 60_000);
export const addDays = (d: Date, days: number) => new Date(d.getTime() + days * 86_400_000);
/** Postgres `time` comes back as HH:MM:SS; the API uses HH:MM. */
export const hhmm = (t: string) => t.slice(0, 5);
