import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { join } from 'node:path';
import { FakeAiProvider } from '../../src/ai/fake.js';
import { createApp } from '../../src/app.js';
import type { AppleVerifier } from '../../src/auth/apple.js';
import { signAccessToken } from '../../src/auth/jwt.js';
import { loadConfig } from '../../src/config.js';
import { AppError } from '../../src/lib/errors.js';
import { type Database, createDatabase } from '../../src/db/client.js';
import type { Deps } from '../../src/deps.js';
import { RecordingQueue } from '../../src/jobs/queue.js';
import { FixedClock } from '../../src/lib/clock.js';
import { runMigrations } from '../../src/migrate.js';

/** Treats the "ID token" as the Apple subject, so tests can sign in as anyone. */
export class FakeAppleVerifier implements AppleVerifier {
  async verify(idToken: string) {
    if (idToken === 'bad') throw new AppError(401, 'invalid_apple_token', 'bad token');
    return { sub: idToken, email: null };
  }
}

export interface Harness {
  container: StartedPostgreSqlContainer;
  database: Database;
  deps: Deps;
  clock: FixedClock;
  queue: RecordingQueue;
  ai: FakeAiProvider;
  app: ReturnType<typeof createApp>;
  request(method: string, path: string, opts?: { token?: string; body?: unknown; headers?: Record<string, string> }): Promise<{
    status: number;
    body: any;
    headers: Headers;
  }>;
  signIn(sub?: string, extra?: Record<string, unknown>): Promise<{ token: string; accessToken: string; refresh: string; userId: string }>;
  stop(): Promise<void>;
}

let subCounter = 0;

export async function startHarness(env: Record<string, string> = {}): Promise<Harness> {
  const container = await new PostgreSqlContainer('postgres:17-alpine').start();
  const url = container.getConnectionUri();
  await runMigrations(url, join(import.meta.dirname, '../../src/db/migrations'));

  const config = loadConfig({
    NODE_ENV: 'test',
    DATABASE_URL: url,
    JWT_SECRET: 'test-secret-test-secret-test-secret-123',
    APPLE_CLIENT_IDS: 'app.twenty.ios',
    AI_PROVIDER: 'fake',
    ...env,
  });
  const database = createDatabase(url, 5);
  const clock = new FixedClock(new Date('2026-11-02T05:00:00Z'));
  const queue = new RecordingQueue();
  const ai = new FakeAiProvider();
  const deps: Deps = { config, database, clock, queue, apple: new FakeAppleVerifier(), ai };
  const app = createApp(deps);

  const request: Harness['request'] = async (method, path, opts = {}) => {
    const headers: Record<string, string> = { ...(opts.headers ?? {}) };
    if (opts.token) {
      // `user:<id>` tokens are minted at the current fake time, so tests can move the clock freely.
      const bearer = opts.token.startsWith('user:')
        ? await signAccessToken(config, opts.token.slice(5), clock.now())
        : opts.token;
      headers.authorization = `Bearer ${bearer}`;
    }
    if (opts.body !== undefined) headers['content-type'] = 'application/json';
    const res = await app.request(path, {
      method,
      headers,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null, headers: res.headers };
  };

  const signIn: Harness['signIn'] = async (sub, extra = {}) => {
    const res = await request('POST', '/v1/auth/apple', {
      body: { id_token: sub ?? `apple-user-${process.pid}-${++subCounter}-${Date.now()}`, timezone: 'Asia/Shanghai', ...extra },
    });
    if (res.status !== 200) throw new Error(`sign-in failed: ${res.status} ${JSON.stringify(res.body)}`);
    return {
      token: `user:${res.body.user_id}`,
      accessToken: res.body.access_token,
      refresh: res.body.refresh_token,
      userId: res.body.user_id,
    };
  };

  return {
    container,
    database,
    deps,
    clock,
    queue,
    ai,
    app,
    request,
    signIn,
    async stop() {
      await database.close();
      await container.stop();
    },
  };
}

/** Local Shanghai time on 2026-11-02 (or a given date) as an ISO string. */
export const sh = (hhmm: string, date = '2026-11-02') => `${date}T${hhmm.length === 5 ? `${hhmm}:00` : hhmm}+08:00`;
