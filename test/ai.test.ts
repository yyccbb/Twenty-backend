import { describe, expect, it } from 'vitest';
import { AiOutputError, parseBreakdown } from '../src/ai/breakdown.js';

describe('parseBreakdown', () => {
  it('accepts well-formed output', () => {
    const out = parseBreakdown(JSON.stringify({ summary: 'Plan', items: [{ title: 'Read', duration_bars: 2 }] }), 5);
    expect(out.summary).toBe('Plan');
    expect(out.items[0]).toMatchObject({ title: 'Read', duration_bars: 2, description: null, sessions_per_week: null });
  });

  it('repairs durations to whole 20-minute bars', () => {
    const out = parseBreakdown(
      JSON.stringify({
        items: [
          { title: 'Minutes', duration_minutes: 45 },
          { title: 'Fractional', duration_bars: 1.4 },
          { title: 'String', duration_bars: '3' },
          { title: 'Tiny', duration_minutes: 5 },
          { title: 'Huge', duration_bars: 500 },
        ],
      }),
      10,
    );
    expect(out.items.map((i) => i.duration_bars)).toEqual([2, 1, 3, 1, 72]);
  });

  it('drops unrepairable items and caps the count', () => {
    const out = parseBreakdown(
      JSON.stringify({ items: [{ title: 'No duration' }, { title: '', duration_bars: 1 }, { title: 'A', duration_bars: 1 }, { title: 'B', duration_bars: 1 }] }),
      1,
    );
    expect(out.items.map((i) => i.title)).toEqual(['A']);
  });

  it('strips code fences and rejects non-JSON or empty results', () => {
    expect(parseBreakdown('```json\n{"items":[{"title":"A","duration_bars":1}]}\n```', 3).items).toHaveLength(1);
    expect(() => parseBreakdown('sorry, I cannot', 3)).toThrow(AiOutputError);
    expect(() => parseBreakdown('{"items": []}', 3)).toThrow(AiOutputError);
    expect(() => parseBreakdown('{"items": [{"title": "A", "duration_bars": -2}]}', 3)).toThrow(AiOutputError);
  });
});
