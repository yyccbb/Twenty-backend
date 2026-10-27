import { createRoute, z } from '@hono/zod-openapi';
import { acceptBreakdown, getBreakdown, requestBreakdown } from '../services/breakdowns.js';
import { createGoal, deleteGoal, getOwnedGoal, goalDto, listGoals, updateGoal } from '../services/goals.js';
import { DateTime, IdParam, IdempotencyHeaders, PageQuery, type RouteModule, Uuid, body, errors, json, security } from './common.js';
import { BreakdownSchema, EventKind, EventSchema, GoalSchema } from './schemas.js';

const TargetDate = z.iso.date().nullish();
const GoalStatus = z.enum(['active', 'achieved', 'archived']);

export const goalRoutes: RouteModule = (app, deps) => {
  app.openapi(
    createRoute({
      method: 'get',
      path: '/v1/goals',
      tags: ['Goals & AI'],
      summary: 'List goals',
      security,
      request: { query: PageQuery },
      responses: {
        200: json(z.object({ items: z.array(GoalSchema), next_cursor: z.string().nullable() }).openapi('GoalPage')),
        ...errors(400, 401),
      },
    }),
    async (c) => {
      const q = c.req.valid('query');
      return c.json(await listGoals(deps.database.db, c.get('userId'), q.cursor, q.limit), 200);
    },
  );

  app.openapi(
    createRoute({
      method: 'get',
      path: '/v1/goals/{id}',
      tags: ['Goals & AI'],
      summary: 'One goal',
      security,
      request: { params: IdParam },
      responses: { 200: json(GoalSchema), ...errors(401, 404) },
    }),
    async (c) => c.json(goalDto(await getOwnedGoal(deps.database.db, c.get('userId'), c.req.valid('param').id)), 200),
  );

  app.openapi(
    createRoute({
      method: 'post',
      path: '/v1/goals',
      tags: ['Goals & AI'],
      summary: 'Create a goal',
      security,
      request: {
        headers: IdempotencyHeaders,
        body: body(z.object({ title: z.string().min(1).max(200), description: z.string().max(5000).nullish(), target_date: TargetDate })),
      },
      responses: { 201: json(GoalSchema, 'Created'), ...errors(400, 401) },
    }),
    async (c) => c.json(await createGoal(deps, c.get('userId'), c.req.valid('json')), 201),
  );

  app.openapi(
    createRoute({
      method: 'patch',
      path: '/v1/goals/{id}',
      tags: ['Goals & AI'],
      summary: 'Edit a goal',
      security,
      request: {
        params: IdParam,
        headers: IdempotencyHeaders,
        body: body(
          z.object({
            title: z.string().min(1).max(200).optional(),
            description: z.string().max(5000).nullable().optional(),
            target_date: TargetDate,
            status: GoalStatus.optional(),
          }),
        ),
      },
      responses: { 200: json(GoalSchema), ...errors(400, 401, 404) },
    }),
    async (c) => c.json(await updateGoal(deps, c.get('userId'), c.req.valid('param').id, c.req.valid('json')), 200),
  );

  app.openapi(
    createRoute({
      method: 'delete',
      path: '/v1/goals/{id}',
      tags: ['Goals & AI'],
      summary: 'Delete a goal and its breakdowns (events made from it stay, unlinked)',
      security,
      request: { params: IdParam, headers: IdempotencyHeaders },
      responses: { 204: { description: 'Deleted' }, ...errors(401, 404) },
    }),
    async (c) => {
      await deleteGoal(deps, c.get('userId'), c.req.valid('param').id);
      return c.body(null, 204);
    },
  );

  app.openapi(
    createRoute({
      method: 'post',
      path: '/v1/goals/{id}/breakdowns',
      tags: ['Goals & AI'],
      summary: 'Start an AI breakdown of the goal',
      description: 'Runs in the background; poll GET /v1/breakdowns/{id}. Limited per user per local day (429 daily_limit_reached).',
      security,
      request: {
        params: IdParam,
        headers: IdempotencyHeaders,
        body: {
          required: false,
          content: {
            'application/json': {
              schema: z.object({
                hints: z.string().max(2000).nullish(),
                max_items: z.number().int().min(1).max(20).optional(),
              }),
            },
          },
        },
      },
      responses: {
        202: json(z.object({ breakdown_id: z.string(), status: z.literal('queued') }).openapi('BreakdownQueued'), 'Queued'),
        ...errors(400, 401, 404, 429),
      },
    }),
    async (c) => {
      const input = (c.req.header('content-type')?.includes('json') ? c.req.valid('json') : undefined) ?? {};
      return c.json(await requestBreakdown(deps, c.get('userId'), c.req.valid('param').id, input), 202);
    },
  );

  app.openapi(
    createRoute({
      method: 'get',
      path: '/v1/breakdowns/{id}',
      tags: ['Goals & AI'],
      summary: 'Poll a breakdown: status and suggested activities sized in 20-minute bars',
      security,
      request: { params: IdParam },
      responses: { 200: json(BreakdownSchema), ...errors(401, 404) },
    }),
    async (c) => c.json(await getBreakdown(deps.database.db, c.get('userId'), c.req.valid('param').id), 200),
  );

  app.openapi(
    createRoute({
      method: 'post',
      path: '/v1/breakdowns/{id}/accept',
      tags: ['Goals & AI'],
      summary: 'Place chosen items on the calendar',
      description:
        'Creates one event per chosen item in a single transaction; any rule violation rejects them all. Each item becomes a Cadenza unless `kind` says tutti.',
      security,
      request: {
        params: IdParam,
        headers: IdempotencyHeaders,
        body: body(
          z.object({
            items: z
              .array(
                z.object({
                  item_id: Uuid,
                  planned_start: DateTime,
                  kind: EventKind.default('cadenza'),
                  duration_bars: z.number().optional(),
                  title: z.string().min(1).max(200).optional(),
                  notes: z.string().max(5000).nullable().optional(),
                }),
              )
              .min(1)
              .max(50),
          }),
        ),
      },
      responses: { 201: json(z.object({ events: z.array(EventSchema) }), 'Created'), ...errors(400, 401, 404, 409, 422) },
    }),
    async (c) => c.json(await acceptBreakdown(deps, c.get('userId'), c.req.valid('param').id, c.req.valid('json').items), 201),
  );
};
