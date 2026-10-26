import { createRoute, z } from '@hono/zod-openapi';
import { cancelEvent, createEvent, getOwnedEvent, eventDto, listEvents, updateEvent } from '../services/events.js';
import { extendEvent, finishEvent, startEvent } from '../services/recording.js';
import { DateTime, IdParam, IdempotencyHeaders, PageQuery, type RouteModule, body, errors, json, security, Uuid } from './common.js';
import { parseRange } from './range.js';
import { EventPage, EventSchema, ExtendResultSchema, FinishResultSchema, StartResultSchema } from './schemas.js';

const TapBody = z.object({
  tapped_at: DateTime.openapi({ description: 'Raw device time of the tap; queued offline taps up to 24 h old are accepted' }),
});

export const eventRoutes: RouteModule = (app, deps) => {
  app.openapi(
    createRoute({
      method: 'get',
      path: '/v1/events',
      tags: ['Calendar'],
      summary: 'Events whose planned block intersects [from, to)',
      security,
      request: { query: PageQuery.extend({ from: DateTime, to: DateTime }) },
      responses: { 200: json(EventPage), ...errors(400, 401) },
    }),
    async (c) => {
      const q = c.req.valid('query');
      const range = parseRange(q.from, q.to, 92);
      return c.json(await listEvents(deps.database.db, c.get('userId'), range.from, range.to, q.cursor, q.limit), 200);
    },
  );

  app.openapi(
    createRoute({
      method: 'get',
      path: '/v1/events/{id}',
      tags: ['Calendar'],
      summary: 'One event with its start/finish record',
      security,
      request: { params: IdParam },
      responses: { 200: json(EventSchema), ...errors(401, 404) },
    }),
    async (c) => c.json(eventDto(await getOwnedEvent(deps.database.db, c.get('userId'), c.req.valid('param').id)), 200),
  );

  app.openapi(
    createRoute({
      method: 'post',
      path: '/v1/events',
      tags: ['Calendar'],
      summary: 'Create an event',
      description:
        'planned_start must be on a :00/:20/:40 mark (422 slot_misaligned) and duration_slots a whole number ≥ 1 (422 invalid_duration). At most 2 events may overlap (409 overlap_limit).',
      security,
      request: {
        headers: IdempotencyHeaders,
        body: body(
          z.object({
            title: z.string().min(1).max(200),
            notes: z.string().max(5000).nullish(),
            planned_start: DateTime,
            duration_slots: z.number().openapi({ description: 'Whole 20-minute slots, at least 1' }),
            rewardable: z.boolean().optional(),
            goal_id: Uuid.nullish(),
          }),
        ),
      },
      responses: { 201: json(EventSchema, 'Created'), ...errors(400, 401, 404, 409, 422) },
    }),
    async (c) => c.json(await createEvent(deps, c.get('userId'), c.req.valid('json')), 201),
  );

  app.openapi(
    createRoute({
      method: 'patch',
      path: '/v1/events/{id}',
      tags: ['Calendar'],
      summary: 'Edit or reschedule an event',
      description: 'Send the current `version`; a stale version returns 409 version_conflict. Only planned events can be rescheduled.',
      security,
      request: {
        params: IdParam,
        headers: IdempotencyHeaders,
        body: body(
          z.object({
            version: z.number().int(),
            title: z.string().min(1).max(200).optional(),
            notes: z.string().max(5000).nullable().optional(),
            planned_start: DateTime.optional(),
            duration_slots: z.number().optional(),
            rewardable: z.boolean().optional(),
            goal_id: Uuid.nullable().optional(),
          }),
        ),
      },
      responses: { 200: json(EventSchema), ...errors(400, 401, 404, 409, 422) },
    }),
    async (c) => c.json(await updateEvent(deps, c.get('userId'), c.req.valid('param').id, c.req.valid('json')), 200),
  );

  app.openapi(
    createRoute({
      method: 'delete',
      path: '/v1/events/{id}',
      tags: ['Calendar'],
      summary: 'Cancel a planned event',
      security,
      request: { params: IdParam, headers: IdempotencyHeaders },
      responses: { 200: json(EventSchema), ...errors(401, 404, 409) },
    }),
    async (c) => c.json(await cancelEvent(deps, c.get('userId'), c.req.valid('param').id), 200),
  );

  app.openapi(
    createRoute({
      method: 'post',
      path: '/v1/events/{id}/start',
      tags: ['Recording'],
      summary: 'Record a start tap',
      description:
        'recorded_start = snap(tapped_at). Up to 2 slots early is allowed (more: 422 too_early); an early start that would make 3 events overlap returns 409 overlap_limit. A start that snaps to the planned end marks the event missed.',
      security,
      request: { params: IdParam, headers: IdempotencyHeaders, body: body(TapBody) },
      responses: { 200: json(StartResultSchema), ...errors(400, 401, 404, 409, 422) },
    }),
    async (c) =>
      c.json(await startEvent(deps, c.get('userId'), c.req.valid('param').id, new Date(c.req.valid('json').tapped_at)), 200),
  );

  app.openapi(
    createRoute({
      method: 'post',
      path: '/v1/events/{id}/extend',
      tags: ['Recording'],
      summary: 'Extend an event in progress by whole slots, pushing later events',
      description:
        'Allowed until 5 minutes after the planned end. Later events it runs into are pushed by the same amount, in one transaction; every moved event is returned. `dry_run: true` returns the preview without saving. Rejected (409) if a pushed event is in progress or done (pushed_event_locked) or the overlap limit would break.',
      security,
      request: {
        params: IdParam,
        headers: IdempotencyHeaders,
        body: body(z.object({ slots: z.number(), dry_run: z.boolean().default(false) })),
      },
      responses: { 200: json(ExtendResultSchema), ...errors(400, 401, 404, 409, 422) },
    }),
    async (c) => {
      const { slots, dry_run } = c.req.valid('json');
      return c.json(await extendEvent(deps, c.get('userId'), c.req.valid('param').id, slots, dry_run), 200);
    },
  );

  app.openapi(
    createRoute({
      method: 'post',
      path: '/v1/events/{id}/finish',
      tags: ['Recording'],
      summary: 'Record a finish tap and award tokens',
      description:
        'A tap in (E−15, E+5] is on time; earlier taps shorten the event; a tap after E+5 counts as auto-finish (one slot deducted); a finish that snaps to the recorded start is abandoned.',
      security,
      request: { params: IdParam, headers: IdempotencyHeaders, body: body(TapBody) },
      responses: { 200: json(FinishResultSchema), ...errors(400, 401, 404, 409, 422) },
    }),
    async (c) =>
      c.json(await finishEvent(deps, c.get('userId'), c.req.valid('param').id, new Date(c.req.valid('json').tapped_at)), 200),
  );
};
