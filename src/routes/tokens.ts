import { createRoute, z } from '@hono/zod-openapi';
import { listBadges, redeemBadge } from '../services/badges.js';
import { listLedger } from '../services/ledger.js';
import { IdParam, IdempotencyHeaders, PageQuery, type RouteModule, errors, json, security } from './common.js';
import { BadgeSchema, LedgerEntrySchema } from './schemas.js';

export const tokenRoutes: RouteModule = (app, deps) => {
  app.openapi(
    createRoute({
      method: 'get',
      path: '/v1/tokens/ledger',
      tags: ['Tokens & badges'],
      summary: 'Token history, newest first',
      security,
      request: { query: PageQuery },
      responses: {
        200: json(
          z
            .object({ balance: z.number().int(), entries: z.array(LedgerEntrySchema), next_cursor: z.string().nullable() })
            .openapi('LedgerPage'),
        ),
        ...errors(400, 401),
      },
    }),
    async (c) => {
      const q = c.req.valid('query');
      return c.json(await listLedger(deps.database.db, c.get('userId'), q.cursor, q.limit), 200);
    },
  );

  app.openapi(
    createRoute({
      method: 'get',
      path: '/v1/badges',
      tags: ['Tokens & badges'],
      summary: 'Badge catalog and which ones the user owns',
      security,
      responses: { 200: json(z.object({ badges: z.array(BadgeSchema) })), ...errors(401) },
    }),
    async (c) => c.json({ badges: await listBadges(deps.database.db, c.get('userId')) }, 200),
  );

  app.openapi(
    createRoute({
      method: 'post',
      path: '/v1/badges/{id}/redeem',
      tags: ['Tokens & badges'],
      summary: 'Spend tokens on a badge',
      description: '409 insufficient_tokens if the balance is too low; 409 already_owned if owned.',
      security,
      request: { params: IdParam, headers: IdempotencyHeaders },
      responses: {
        200: json(
          z.object({ badge: BadgeSchema, token_balance: z.number().int(), ledger_entry: LedgerEntrySchema }).openapi('RedeemResult'),
        ),
        ...errors(401, 404, 409),
      },
    }),
    async (c) => c.json(await redeemBadge(deps, c.get('userId'), c.req.valid('param').id), 200),
  );
};
