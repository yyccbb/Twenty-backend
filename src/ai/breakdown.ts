import { z } from 'zod';
import { uuidv7 } from '../db/ids.js';
import type { BreakdownItem } from '../db/schema.js';
import type { AiMessage, AiProvider } from './provider.js';

export const BREAKDOWN_PROMPT_VERSION = 'breakdown-v1';
export const MAX_ITEM_SLOTS = 72;

export class AiOutputError extends Error {}

export interface BreakdownInput {
  goal: { title: string; description: string | null; target_date: string | null };
  hints: string | null;
  maxItems: number;
  today: string;
}

export function buildBreakdownMessages(input: BreakdownInput): AiMessage[] {
  const system = [
    'You help people turn a long-term goal into concrete, schedulable activities.',
    'Time is planned in 20-minute slots. Every activity duration must be a whole number of slots (1 slot = 20 minutes).',
    'Reply with one JSON object only, no prose, in exactly this shape:',
    '{"summary": string, "items": [{"title": string, "description": string|null, "duration_slots": integer >= 1, "sessions_per_week": integer|null}]}',
    `Return between 1 and ${input.maxItems} items. Keep titles under 80 characters. Prefer 1 to 6 slots per activity.`,
    'Answer in the same language as the goal.',
  ].join('\n');
  const user = JSON.stringify({
    today: input.today,
    goal: input.goal.title,
    description: input.goal.description,
    target_date: input.goal.target_date,
    hints: input.hints,
  });
  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
}

const numeric = z.union([z.number(), z.string().regex(/^\s*\d+(\.\d+)?\s*$/).transform(Number)]);

const RawItem = z.object({
  title: z.string().trim().min(1),
  description: z.string().nullish(),
  duration_slots: numeric.nullish(),
  duration_minutes: numeric.nullish(),
  sessions_per_week: numeric.nullish(),
});

const RawBreakdown = z.object({
  summary: z.string().nullish(),
  items: z.array(z.unknown()).min(1),
});

/** Strips code fences and surrounding prose that models sometimes add despite JSON mode. */
function extractJson(content: string): unknown {
  const trimmed = content.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  try {
    return JSON.parse(trimmed);
  } catch {
    const start = trimmed.indexOf('{');
    const end = trimmed.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(trimmed.slice(start, end + 1));
      } catch {
        // fall through
      }
    }
    throw new AiOutputError('model output is not JSON');
  }
}

/** Repairs a duration to whole 20-minute slots, or returns null if it can't be repaired. */
function repairSlots(item: z.infer<typeof RawItem>): number | null {
  const raw = item.duration_slots ?? (item.duration_minutes != null ? item.duration_minutes / 20 : null);
  if (raw == null || !Number.isFinite(raw) || raw <= 0) return null;
  return Math.min(MAX_ITEM_SLOTS, Math.max(1, Math.round(raw)));
}

/** Validates model output with Zod: durations must be whole slots (repaired when possible); bad items are dropped. */
export function parseBreakdown(content: string, maxItems: number): { summary: string | null; items: BreakdownItem[] } {
  const parsed = RawBreakdown.safeParse(extractJson(content));
  if (!parsed.success) throw new AiOutputError('model output does not match the breakdown shape');
  const items: BreakdownItem[] = [];
  for (const candidate of parsed.data.items) {
    const item = RawItem.safeParse(candidate);
    if (!item.success) continue;
    const slots = repairSlots(item.data);
    if (slots === null) continue;
    const sessions = item.data.sessions_per_week;
    items.push({
      id: uuidv7(),
      title: item.data.title.slice(0, 120),
      description: item.data.description?.trim() || null,
      duration_slots: slots,
      sessions_per_week: sessions != null && Number.isInteger(sessions) && sessions >= 1 && sessions <= 21 ? sessions : null,
    });
    if (items.length === maxItems) break;
  }
  if (items.length === 0) throw new AiOutputError('model output has no usable activities');
  return { summary: parsed.data.summary?.trim() || null, items };
}

export async function generateBreakdown(provider: AiProvider, input: BreakdownInput, signal?: AbortSignal) {
  const completion = await provider.completeJson(buildBreakdownMessages(input), { signal });
  return { ...parseBreakdown(completion.content, input.maxItems), model: completion.model, tokensUsed: completion.tokensUsed };
}
