import { describe, expect, it } from 'vitest';
import { uuidv7 } from '../src/db/ids.js';

describe('uuidv7', () => {
  it('is a version-7, RFC 9562 variant UUID that sorts by creation time', () => {
    const ids = Array.from({ length: 1000 }, () => uuidv7());
    for (const id of ids) expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect([...ids].sort()).toEqual(ids);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
