import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { HTTPException } from 'hono/http-exception';
import { etag } from 'hono/etag';
import type { Deps } from './deps.js';
import { AppError } from './lib/errors.js';
import { logger } from './lib/logger.js';
import { authRoutes } from './routes/auth.js';
import { calendarRoutes } from './routes/calendar.js';
import type { AppEnv } from './routes/common.js';
import { eventRoutes } from './routes/events.js';
import { goalRoutes } from './routes/goals.js';
import { meRoutes } from './routes/me.js';
import { idempotency, requestContext, requireAuth } from './routes/middleware.js';
import { reminderRoutes } from './routes/reminders.js';
import { tokenRoutes } from './routes/tokens.js';

export const OPENAPI_INFO = {
  openapi: '3.1.0',
  info: {
    title: 'Twenty API',
    version: '1.0.0',
    description:
      'Backend for Twenty, a school timetable for adults. Times are ISO 8601 instants; all grid math uses 20-minute slots. Errors use { "error": { "code", "message" } }.',
  },
} as const;

export function createApp(deps: Deps) {
  const app = new OpenAPIHono<AppEnv>({
    defaultHook: (result, c) => {
      if (!result.success) {
        const issue = result.error.issues[0];
        const where = issue?.path.length ? `${issue.path.join('.')}: ` : '';
        return c.json({ error: { code: 'invalid_request', message: `${where}${issue?.message ?? 'Invalid request'}` } }, 400);
      }
    },
  });

  app.openAPIRegistry.registerComponent('securitySchemes', 'Bearer', { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' });

  app.use('*', requestContext);
  const auth = requireAuth(deps);
  const idem = idempotency(deps);
  const tag = etag();
  app.use('/v1/*', async (c, next) => (c.req.path.startsWith('/v1/auth/') ? next() : auth(c, next)));
  app.use('/v1/*', async (c, next) => (c.req.path.startsWith('/v1/auth/') ? next() : idem(c, next)));
  app.use('/v1/*', async (c, next) => (c.req.method === 'GET' ? tag(c, next) : next()));

  app.openapi(
    createRoute({
      method: 'get',
      path: '/healthz',
      tags: ['Ops'],
      summary: 'Liveness check',
      responses: { 200: { description: 'Alive', content: { 'application/json': { schema: z.object({ status: z.literal('ok') }) } } } },
    }),
    (c) => c.json({ status: 'ok' as const }, 200),
  );

  for (const register of [authRoutes, meRoutes, eventRoutes, calendarRoutes, reminderRoutes, goalRoutes, tokenRoutes]) {
    register(app, deps);
  }

  app.doc31('/openapi.json', OPENAPI_INFO);

  app.notFound((c) => c.json({ error: { code: 'not_found', message: 'No such endpoint' } }, 404));
  app.onError((err, c) => {
    if (err instanceof AppError) return c.json(err.toBody(), err.status);
    if (err instanceof HTTPException) {
      return c.json({ error: { code: 'http_error', message: err.message || 'Request failed' } }, err.status);
    }
    if (err instanceof SyntaxError) return c.json({ error: { code: 'invalid_request', message: 'Malformed JSON body' } }, 400);
    logger.error({ err }, 'unhandled error');
    return c.json({ error: { code: 'internal_error', message: 'Something went wrong' } }, 500);
  });

  return app;
}
