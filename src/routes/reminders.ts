import { createRoute, z } from '@hono/zod-openapi';
import {
  createReminder,
  deleteReminder,
  getReminder,
  listReminders,
  setOccurrenceState,
  updateReminder,
} from '../services/reminders.js';
import { DateTime, IdParam, IdempotencyHeaders, PageQuery, type RouteModule, body, errors, json, security } from './common.js';
import { OccurrenceSchema, ReminderSchema } from './schemas.js';

const Scope = z.enum(['this', 'following', 'all']).openapi('EditScope');

export const reminderRoutes: RouteModule = (app, deps) => {
  app.openapi(
    createRoute({
      method: 'get',
      path: '/v1/reminders',
      tags: ['Reminders'],
      summary: 'List reminder definitions',
      security,
      request: { query: PageQuery },
      responses: {
        200: json(z.object({ items: z.array(ReminderSchema), next_cursor: z.string().nullable() }).openapi('ReminderPage')),
        ...errors(400, 401),
      },
    }),
    async (c) => {
      const q = c.req.valid('query');
      return c.json(await listReminders(deps.database.db, c.get('userId'), q.cursor, q.limit), 200);
    },
  );

  app.openapi(
    createRoute({
      method: 'get',
      path: '/v1/reminders/{id}',
      tags: ['Reminders'],
      summary: 'One reminder definition',
      security,
      request: { params: IdParam },
      responses: { 200: json(ReminderSchema), ...errors(401, 404) },
    }),
    async (c) => c.json(await getReminder(deps.database.db, c.get('userId'), c.req.valid('param').id), 200),
  );

  app.openapi(
    createRoute({
      method: 'post',
      path: '/v1/reminders',
      tags: ['Reminders'],
      summary: 'Create a reminder (any minute; optional RFC 5545 RRULE)',
      security,
      request: {
        headers: IdempotencyHeaders,
        body: body(
          z.object({
            title: z.string().min(1).max(200),
            notes: z.string().max(5000).nullish(),
            at: DateTime,
            timezone: z.string().optional().openapi({ description: "Defaults to the user's time zone" }),
            rrule: z.string().max(500).nullish().openapi({ example: 'FREQ=MONTHLY;BYDAY=2TU' }),
          }),
        ),
      },
      responses: { 201: json(ReminderSchema, 'Created'), ...errors(400, 401, 422) },
    }),
    async (c) => c.json(await createReminder(deps, c.get('userId'), c.req.valid('json')), 201),
  );

  app.openapi(
    createRoute({
      method: 'patch',
      path: '/v1/reminders/{id}',
      tags: ['Reminders'],
      summary: 'Edit a reminder',
      description:
        'A repeating reminder needs `scope`: `this` (one occurrence; needs `occurrence`), `following` (splits the series at `occurrence`; the new part is returned as `created`) or `all`.',
      security,
      request: {
        params: IdParam,
        headers: IdempotencyHeaders,
        body: body(
          z.object({
            version: z.number().int(),
            scope: Scope.optional(),
            occurrence: DateTime.optional().openapi({ description: 'Original time of the occurrence being edited' }),
            title: z.string().min(1).max(200).optional(),
            notes: z.string().max(5000).nullable().optional(),
            at: DateTime.optional(),
            timezone: z.string().optional(),
            rrule: z.string().max(500).nullable().optional(),
          }),
        ),
      },
      responses: {
        200: json(z.object({ reminder: ReminderSchema, created: ReminderSchema.nullable() }).openapi('ReminderEditResult')),
        ...errors(400, 401, 404, 409, 422),
      },
    }),
    async (c) => c.json(await updateReminder(deps, c.get('userId'), c.req.valid('param').id, c.req.valid('json')), 200),
  );

  app.openapi(
    createRoute({
      method: 'delete',
      path: '/v1/reminders/{id}',
      tags: ['Reminders'],
      summary: 'Delete a reminder, one occurrence, or this and following',
      security,
      request: {
        params: IdParam,
        headers: IdempotencyHeaders,
        query: z.object({ scope: Scope.optional(), occurrence: DateTime.optional() }),
      },
      responses: { 204: { description: 'Deleted' }, ...errors(400, 401, 404, 422) },
    }),
    async (c) => {
      const q = c.req.valid('query');
      await deleteReminder(deps, c.get('userId'), c.req.valid('param').id, q.scope, q.occurrence);
      return c.body(null, 204);
    },
  );

  app.openapi(
    createRoute({
      method: 'put',
      path: '/v1/reminders/{id}/occurrences/{original_at}',
      tags: ['Reminders'],
      summary: 'Mark one occurrence done, skipped, snoozed or moved',
      description: '`new_at` is required for snoozed and moved. `pending` clears the state.',
      security,
      request: {
        params: IdParam.extend({
          original_at: DateTime.openapi({ param: { name: 'original_at', in: 'path' } }),
        }),
        headers: IdempotencyHeaders,
        body: body(
          z.object({
            status: z.enum(['pending', 'done', 'skipped', 'snoozed', 'moved']),
            new_at: DateTime.nullish(),
          }),
        ),
      },
      responses: { 200: json(OccurrenceSchema), ...errors(400, 401, 404, 409, 422) },
    }),
    async (c) => {
      const p = c.req.valid('param');
      return c.json(await setOccurrenceState(deps, c.get('userId'), p.id, p.original_at, c.req.valid('json')), 200);
    },
  );
};
