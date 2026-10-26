import { type OpenAPIHono, z } from '@hono/zod-openapi';
import type { Deps } from '../deps.js';

export interface AppEnv {
  Variables: { userId: string; requestId: string };
}
export type App = OpenAPIHono<AppEnv>;
export type RouteModule = (app: App, deps: Deps) => void;

export const DateTime = z.iso.datetime({ offset: true }).openapi({ example: '2026-11-02T14:00:00+08:00' });
export const LocalTime = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/)
  .openapi({ example: '00:00', description: 'Local wall-clock time, HH:MM' });
export const Uuid = z.uuid();

export const ErrorSchema = z
  .object({
    error: z.object({
      code: z.string().openapi({ example: 'overlap_limit' }),
      message: z.string(),
      conflicts: z.array(z.string()).optional().openapi({ description: 'Sorted IDs of the conflicting events' }),
    }),
  })
  .openapi('Error');

const ERROR_DESCRIPTIONS: Record<number, string> = {
  400: 'Malformed request',
  401: 'Missing or invalid credentials',
  404: 'Not found',
  409: 'Conflict with the current state',
  422: 'The request breaks a rule',
  429: 'Limit reached',
};

export function errors(...codes: number[]) {
  return Object.fromEntries(
    codes.map((code) => [code, { description: ERROR_DESCRIPTIONS[code] ?? 'Error', content: { 'application/json': { schema: ErrorSchema } } }]),
  );
}

export function json<T extends z.ZodType>(schema: T, description = 'OK') {
  return { description, content: { 'application/json': { schema } } };
}

export const body = <T extends z.ZodType>(schema: T) => ({
  required: true,
  content: { 'application/json': { schema } },
});

export const IdempotencyHeaders = z.object({
  'idempotency-key': z.string().min(1).max(255).optional().openapi({
    description: 'Retries with the same key replay the first response instead of repeating the write',
  }),
});

export const IdParam = z.object({ id: Uuid.openapi({ param: { name: 'id', in: 'path' } }) });

export const PageQuery = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

export const security = [{ Bearer: [] }];
