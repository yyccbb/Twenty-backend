import { createHash, randomUUID } from 'node:crypto';
import { and, eq, isNull } from 'drizzle-orm';
import type { MiddlewareHandler } from 'hono';
import { verifyAccessToken } from '../auth/jwt.js';
import { idempotencyKeys, users } from '../db/schema.js';
import type { Deps } from '../deps.js';
import { AppError } from '../lib/errors.js';
import { logger, withLogContext } from '../lib/logger.js';
import type { AppEnv } from './common.js';

/** Assigns a request ID (or keeps the caller's X-Request-Id) that every log line in the request carries. */
export const requestContext: MiddlewareHandler<AppEnv> = async (c, next) => {
  const requestId = c.req.header('x-request-id')?.slice(0, 128) || randomUUID();
  c.set('requestId', requestId);
  c.header('X-Request-Id', requestId);
  await withLogContext(requestId, async () => {
    const started = performance.now();
    await next();
    logger.info(
      { method: c.req.method, path: c.req.path, status: c.res.status, ms: Math.round(performance.now() - started) },
      'request',
    );
  });
};

export function requireAuth(deps: Deps): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const header = c.req.header('authorization');
    if (!header?.startsWith('Bearer ')) throw new AppError(401, 'unauthorized', 'A Bearer access token is required');
    const userId = await verifyAccessToken(deps.config, header.slice(7), deps.clock.now());
    const [user] = await deps.database.db
      .select({ id: users.id })
      .from(users)
      .where(and(eq(users.id, userId), isNull(users.deletedAt)));
    if (!user) throw new AppError(401, 'invalid_token', 'The account no longer exists');
    c.set('userId', userId);
    await next();
  };
}

const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * Idempotency-Key support for authenticated writes: the first response (below 500) is stored and replayed
 * for retries with the same key. Reusing a key for a different request is rejected.
 */
export function idempotency(deps: Deps): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const key = c.req.header('idempotency-key');
    if (!key || !WRITE_METHODS.has(c.req.method)) return next();
    if (key.length > 255) throw new AppError(400, 'invalid_idempotency_key', 'Idempotency-Key must be at most 255 characters');
    const userId = c.get('userId');
    const db = deps.database.db;
    const requestHash = createHash('sha256').update(`${c.req.method} ${c.req.path}\n${await c.req.text()}`).digest('hex');

    const [claimed] = await db
      .insert(idempotencyKeys)
      .values({ userId, key, method: c.req.method, path: c.req.path, requestHash, createdAt: deps.clock.now() })
      .onConflictDoNothing()
      .returning();
    const row = and(eq(idempotencyKeys.userId, userId), eq(idempotencyKeys.key, key));
    if (!claimed) {
      const [existing] = await db.select().from(idempotencyKeys).where(row);
      if (!existing) throw new AppError(409, 'idempotency_in_progress', 'Retry the request');
      if (existing.requestHash !== requestHash) {
        throw new AppError(422, 'idempotency_key_reused', 'This Idempotency-Key was used for a different request');
      }
      if (existing.statusCode === null) {
        throw new AppError(409, 'idempotency_in_progress', 'A request with this Idempotency-Key is still running');
      }
      return new Response(existing.responseBody || null, {
        status: existing.statusCode,
        headers: existing.responseBody
          ? { 'content-type': 'application/json', 'idempotent-replayed': 'true' }
          : { 'idempotent-replayed': 'true' },
      });
    }

    await next();
    if (c.res.status >= 500) {
      await db.delete(idempotencyKeys).where(row);
      return;
    }
    const text = await c.res.clone().text();
    await db.update(idempotencyKeys).set({ statusCode: c.res.status, responseBody: text }).where(row);
  };
}
