import { createRoute, z } from '@hono/zod-openapi';
import { logout, refreshSession, signInWithApple, signInWithEmail, signUpWithEmail } from '../auth/sessions.js';
import { type RouteModule, body, errors, json } from './common.js';
import { SessionSchema } from './schemas.js';

const SignInResult = SessionSchema.extend({ created: z.boolean() }).openapi('SignInResult');

// Format check only: addresses are not verified in the MVP.
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const Email = z.string().trim().max(254).regex(EMAIL_PATTERN, 'Not a valid email address').openapi({ example: 'ada@example.com' });
const Password = z.string().min(8).max(128);

export const authRoutes: RouteModule = (app, deps) => {
  app.openapi(
    createRoute({
      method: 'post',
      path: '/v1/auth/apple',
      tags: ['Auth'],
      summary: 'Exchange a Sign in with Apple ID token for access and refresh tokens',
      description: 'Creates the user on first sign-in.',
      request: {
        body: body(
          z.object({
            id_token: z.string().min(1),
            nonce: z.string().nullish().openapi({ description: 'The raw nonce whose SHA-256 was sent to Apple' }),
            display_name: z.string().max(100).nullish(),
            timezone: z.string().optional().openapi({ example: 'Asia/Shanghai' }),
            device_label: z.string().max(100).nullish(),
          }),
        ),
      },
      responses: { 200: json(SignInResult), ...errors(400, 401, 422) },
    }),
    async (c) => c.json(await signInWithApple(deps, c.req.valid('json')), 200),
  );

  app.openapi(
    createRoute({
      method: 'post',
      path: '/v1/auth/email/signup',
      tags: ['Auth'],
      summary: 'Create an email + password account and sign in',
      description: 'The email is checked for format only and is not verified. Email accounts are separate from Apple accounts.',
      request: {
        body: body(
          z.object({
            email: Email,
            password: Password,
            display_name: z.string().max(100).nullish(),
            timezone: z.string().optional().openapi({ example: 'Asia/Shanghai' }),
            device_label: z.string().max(100).nullish(),
          }),
        ),
      },
      responses: { 201: json(SessionSchema), ...errors(400, 409, 422) },
    }),
    async (c) => c.json(await signUpWithEmail(deps, c.req.valid('json')), 201),
  );

  app.openapi(
    createRoute({
      method: 'post',
      path: '/v1/auth/email/signin',
      tags: ['Auth'],
      summary: 'Sign in with email and password',
      request: {
        body: body(
          z.object({
            email: Email,
            password: z.string().min(1).max(128),
            device_label: z.string().max(100).nullish(),
          }),
        ),
      },
      responses: { 200: json(SessionSchema), ...errors(400, 401) },
    }),
    async (c) => c.json(await signInWithEmail(deps, c.req.valid('json')), 200),
  );

  app.openapi(
    createRoute({
      method: 'post',
      path: '/v1/auth/refresh',
      tags: ['Auth'],
      summary: 'Rotate a refresh token',
      description: 'The old refresh token stops working. Reusing a rotated token revokes every session of the user.',
      request: { body: body(z.object({ refresh_token: z.string().min(1) })) },
      responses: { 200: json(SessionSchema), ...errors(400, 401) },
    }),
    async (c) => c.json(await refreshSession(deps, c.req.valid('json').refresh_token), 200),
  );

  app.openapi(
    createRoute({
      method: 'post',
      path: '/v1/auth/logout',
      tags: ['Auth'],
      summary: 'Revoke a refresh token',
      request: { body: body(z.object({ refresh_token: z.string().min(1) })) },
      responses: { 204: { description: 'Revoked' }, ...errors(400) },
    }),
    async (c) => {
      await logout(deps, c.req.valid('json').refresh_token);
      return c.body(null, 204);
    },
  );
};
