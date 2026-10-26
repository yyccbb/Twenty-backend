import { createRoute, z } from '@hono/zod-openapi';
import { deleteAccount, getMe, updateSettings } from '../services/users.js';
import { IdempotencyHeaders, LocalTime, type RouteModule, body, errors, json, security } from './common.js';
import { MeSchema, PlanningPrompt } from './schemas.js';

export const meRoutes: RouteModule = (app, deps) => {
  app.openapi(
    createRoute({
      method: 'get',
      path: '/v1/me',
      tags: ['Account'],
      summary: 'Profile, time zone, settings and token balance',
      security,
      responses: { 200: json(MeSchema), ...errors(401) },
    }),
    async (c) => c.json(await getMe(deps.database.db, c.get('userId')), 200),
  );

  app.openapi(
    createRoute({
      method: 'patch',
      path: '/v1/me/settings',
      tags: ['Account'],
      summary: 'Update time zone, planning-prompt schedule, day end and preferences',
      description: 'Time zones that are not a whole number of hours from UTC are rejected with 422 unsupported_timezone.',
      security,
      request: {
        headers: IdempotencyHeaders,
        body: body(
          z.object({
            display_name: z.string().max(100).nullable().optional(),
            timezone: z.string().optional(),
            planning_prompts: z.array(PlanningPrompt).max(50).optional(),
            day_end_local_time: LocalTime.optional(),
            preferences: z.record(z.string(), z.unknown()).optional(),
          }),
        ),
      },
      responses: { 200: json(MeSchema), ...errors(400, 401, 422) },
    }),
    async (c) => c.json(await updateSettings(deps, c.get('userId'), c.req.valid('json')), 200),
  );

  app.openapi(
    createRoute({
      method: 'delete',
      path: '/v1/me',
      tags: ['Account'],
      summary: 'Delete the account and its personal data',
      description: 'Required by App Store rules. All sessions are revoked.',
      security,
      request: { headers: IdempotencyHeaders },
      responses: { 204: { description: 'Deleted' }, ...errors(401) },
    }),
    async (c) => {
      await deleteAccount(deps, c.get('userId'));
      return c.body(null, 204);
    },
  );
};
