import { AppError } from '../lib/errors.js';

export function parseRange(from: string, to: string, maxDays: number): { from: Date; to: Date } {
  const f = new Date(from);
  const t = new Date(to);
  if (t.getTime() <= f.getTime()) throw new AppError(400, 'invalid_range', '`to` must be after `from`');
  if (t.getTime() - f.getTime() > maxDays * 86_400_000) {
    throw new AppError(400, 'invalid_range', `The range may span at most ${maxDays} days`);
  }
  return { from: f, to: t };
}
