# Twenty backend

API and background worker for Twenty. The design spec is
`vendor/Twenty/docs/architecture/backend-tech-stack.md` (the `Twenty` repo, a git submodule); `AGENTS.md` summarises it.

TypeScript on Node 22 · Hono + `@hono/zod-openapi` · PostgreSQL 17 + Drizzle · pg-boss · Sign in with Apple + own JWTs · Qwen (Model Studio) behind `AiProvider`.

## Run it

```sh
git submodule update --init       # vendor/Twenty: spec + rules fixtures/constants (or clone with --recurse-submodules)
npm ci
cp .env.example .env              # set JWT_SECRET, APPLE_CLIENT_IDS, QWEN_API_KEY (or AI_PROVIDER=fake)
docker run -d --name twenty-pg -p 5432:5432 -e POSTGRES_USER=twenty -e POSTGRES_PASSWORD=twenty postgres:17-alpine
npm run migrate:dev
npm run dev                       # API on :3000, spec at /openapi.json
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
src/rules/     pure 20-min grid, snap, start, finish, extend/cascade, overlap, tokens, time zones (no I/O)
src/services/  events, recording, ledger, reminders (+ RRULE expansion), goals, breakdowns, badges, users
src/routes/    Hono routes + Zod schemas (the OpenAPI source)
src/auth/      Apple ID token verification, JWT access tokens, rotating refresh tokens
src/ai/        AiProvider interface, qwen.ts, fake.ts, breakdown prompt + output validation
src/jobs/      pg-boss queue names, options and handlers
src/db/        Drizzle schema, migrations (plain SQL), UUIDv7
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

### Decisions the spec left open

These are my calls; change them if they're wrong:

1. **Late offline taps.** A queued start tap that arrives after `events.close_stale` marked the event `missed` is
   still accepted. A queued finish tap from before `E+5` that arrives after the auto-finish job replaces the
   auto-finish, and the difference is posted as an `adjustment` ledger entry.
2. **`events.close_stale` also auto-finishes** in-progress events more than 6 minutes past `E`, in case their
   auto-finish job was lost.
3. **Account deletion** deletes all personal data but keeps a stripped `users` row (no Apple ID, no name), because
   the append-only ledger references it. Signing in again with the same Apple ID creates a new account.
4. **Unsupported time zones** (non-whole-hour) are rejected with `422 unsupported_timezone` at sign-in and in
   settings. `GET /v1/me` reports `timezone_supported`.
5. **Day end** for a pushed event is the first `day_end_local_time` strictly after the event's start (pre-push).
6. **Reminders:** a deleted single occurrence is stored as occurrence status `cancelled` (an addition to
   done/skipped/snoozed/moved). Editing one occurrence's content creates a standalone copy in the same series.
   `DELETE /v1/reminders/{id}` takes `scope` and `occurrence` as query parameters. Splitting a `COUNT` rule
   carries the remaining count into the new part. Scoped edits apply to the reminder row you name, not to
   every row in the series.
7. **Caps the spec doesn't set:** an event is at most 72 slots (24 h), one extension at most 72 slots, `GET
   /v1/events` spans at most 92 days and `GET /v1/calendar` at most 62.
8. **Abandoned events** occupy no time for overlap checks.
9. The **daily AI limit** counts breakdowns since local midnight in the user's time zone.
10. Concurrent refreshes with the same refresh token count as reuse and revoke every session (there's no grace window).
