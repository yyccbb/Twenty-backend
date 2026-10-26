import { AppError } from './errors.js';

export function encodeCursor(parts: Record<string, string>): string {
  return Buffer.from(JSON.stringify(parts)).toString('base64url');
}

export function decodeCursor<K extends string>(cursor: string | undefined, keys: readonly K[]): Record<K, string> | null {
  if (!cursor) return null;
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    for (const k of keys) if (typeof parsed[k] !== 'string') throw new Error('missing key');
    return parsed;
  } catch {
    throw new AppError(400, 'invalid_cursor', 'The cursor is malformed');
  }
}
