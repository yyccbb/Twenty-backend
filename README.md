# Twenty backend

API and background worker for Twenty. The design lives in the developer guide of the `Twenty` repo (a git submodule):
the product rules in `vendor/Twenty/docs/developer-guide/rules.md`, and the stack, data model and API in
`vendor/Twenty/docs/developer-guide/backend.md`. `AGENTS.md` summarises them.

TypeScript on Node 22 · Hono + `@hono/zod-openapi` · PostgreSQL 17 + Drizzle · pg-boss · Sign in with Apple or email + password, with own JWTs · DeepSeek Flash via SiliconFlow behind `AiProvider`.

## Run it

```sh
git submodule update --init       # vendor/Twenty: developer guide + rules fixtures/constants (or clone with --recurse-submodules)
npm ci
cp .env.example .env              # set JWT_SECRET (≥ 32 chars) and APPLE_CLIENT_IDS; AI_PROVIDER=fake runs without an AI key
docker run -d --name twenty-pg -p 5432:5432 -e POSTGRES_USER=twenty -e POSTGRES_PASSWORD=twenty postgres:17-alpine
npm run migrate:dev
npm run dev                       # API on :3000, OpenAPI at /openapi.json
npm run dev:worker                # jobs + cron
```

Production is `docker compose up -d` (Caddy + api + worker + postgres, plus a one-shot `migrate`). Set `DOMAIN`,
`POSTGRES_PASSWORD` and the app variables in `.env`. In mainland China, point `TWENTY_IMAGE`, `POSTGRES_IMAGE` and
`CADDY_IMAGE` at Alibaba Container Registry copies, and build with
`--build-arg NODE_IMAGE=<ACR mirror> --build-arg NPM_REGISTRY=https://registry.npmmirror.com`.

## Commands

| Command | What |
|---|---|
| `npm test` | Everything. Integration tests start a real Postgres with Testcontainers, so Docker must be running. |
| `npm run test:rules` | Rules engine against `vendor/Twenty/contracts/rules/fixtures.json` (override with `RULES_FIXTURES_PATH`). |
| `npm run typecheck` / `npm run build` | `tsc`; the build emits `dist/server.js`, `dist/worker.js`, `dist/migrate.js`. |
| `npm run openapi` | Regenerates `contracts/openapi.yaml`. A test fails if it drifts from the routes. |
| `npm run db:generate` | Generates a SQL migration from `src/db/schema.ts`. Commit it with the schema change. |

## Layout

```
src/rules/     pure 20-min grid, snap, start, finish, extend/cascade, Cadenza overlap, tokens, time zones (no I/O)
src/services/  events, recording, ledger, cues (+ RRULE expansion), goals, breakdowns, badges, users
src/routes/    Hono routes + Zod schemas (the OpenAPI source)
src/auth/      Apple ID token verification, email/password hashing, JWT access tokens, rotating refresh tokens
src/ai/        AiProvider interface, SiliconFlow and fake providers, breakdown prompt + output validation
src/jobs/      pg-boss queue names, options and handlers
src/db/        Drizzle schema, migrations (plain SQL), UUIDv7
src/lib/       errors, logger, clock, pagination
```

## Behaviour worth knowing

- **Server time is final.** Recorded times come from `src/rules`; clients send raw `tapped_at`. Taps more than
  24 h old or ahead of server time (beyond 2 min of skew) are rejected.
- **Jobs are enqueued inside the same transaction** as the write that needs them (pg-boss `db` option), so an
  auto-finish job exists exactly when the start committed. The auto-finish job is a no-op if the planned end has
  changed since it was scheduled.
- **The ledger is append-only**, enforced by a trigger. Reward payouts use the idempotency key
  `event_reward:<event_id>`, so retries and races can't pay twice, with or without an `Idempotency-Key` header.
- **Writes accept `Idempotency-Key`.** The first response (below 500) is stored for 24 h and replayed with
  `Idempotent-Replayed: true`; reusing a key for a different request returns `422 idempotency_key_reused`.
- Calendar and ledger writes take a per-user row lock, so concurrent requests for one user are serialised.
