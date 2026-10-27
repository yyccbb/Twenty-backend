import { createRoute, z } from '@hono/zod-openapi';
import { eventsInRange } from '../services/events.js';
import { occurrencesInRange } from '../services/cues.js';
import { DateTime, type RouteModule, errors, json, security } from './common.js';
import { parseRange } from './range.js';
import { EventSchema, OccurrenceSchema } from './schemas.js';

export const calendarRoutes: RouteModule = (app, deps) => {
  app.openapi(
    createRoute({
      method: 'get',
      path: '/v1/calendar',
      tags: ['Calendar'],
      summary: 'Events plus expanded cue occurrences in [from, to)',
      description:
        'What iOS uses to schedule its rolling window of local notifications. Repeat rules are expanded on the server. The range may span at most 62 days.',
      security,
      request: { query: z.object({ from: DateTime, to: DateTime }) },
      responses: {
        200: json(z.object({ events: z.array(EventSchema), cues: z.array(OccurrenceSchema) }).openapi('Calendar')),
        ...errors(400, 401),
      },
    }),
    async (c) => {
      const q = c.req.valid('query');
      const { from, to } = parseRange(q.from, q.to, 62);
      const userId = c.get('userId');
      const db = deps.database.db;
      const [evs, cues] = await Promise.all([eventsInRange(db, userId, from, to), occurrencesInRange(db, userId, from, to)]);
      return c.json({ events: evs, cues }, 200);
    },
  );
};
