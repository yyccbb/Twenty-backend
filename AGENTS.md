# AGENTS.md — Twenty backend

Guidance for coding agents working in this repository.

## What Twenty is

Twenty is an iOS-first productivity app (web app later). It combines five things:

1. A calendar where every event is built from **20-minute blocks ("bars")** and is one of two kinds: a **Cadenza** (timed, rewarded focus work) or a **Tutti** (an ordinary event).
2. Scheduled **planning prompts** (for example, a nightly "plan tomorrow" notification).
3. **Planned-vs-actual tracking** for Cadenzas. Start and finish taps snap to the 20-minute grid, so a late start moves the Cadenza to the next block.
4. **AI goal breakdown.** A long-term goal is turned into suggested activities sized in bars, which the user can place on the calendar.
5. A **token and badge economy.** Completed Cadenzas earn tokens, and tokens can be spent on badges.

This repo is the **backend**. Product and design sources live in the `Twenty` repo, checked out as the git submodule `vendor/Twenty/` (`git submodule update --init`):

| Path | What it is |
|---|---|
| `vendor/Twenty/docs/architecture/backend-tech-stack.md` | **The backend design. Treat it as the spec.** All decisions (Q1–Q18) are closed. |
| `vendor/Twenty/contracts/rules/fixtures.json` | Shared test cases and constants for the rules engine (TS and Swift). Do not edit them to make tests pass. Change them in the `Twenty` repo, then bump the submodule. |
| `vendor/Twenty/docs/ideation/market-research.md` | Competitor research and product positioning (background only). |

If code and the spec disagree, follow the spec and flag the mismatch. If the spec is silent or ambiguous, ask instead of inventing behaviour, especially for timing and token rules.

The repo is empty right now. Build it to match the layout and stack below.

## What the backend owns

The backend owns accounts, the calendar (events and cues, i.e. reminders), start/finish recording, the token ledger and badges, goals and AI breakdowns, and user settings. **The server's results are final.** The iOS app has its own copy of the rules, but only to show previews instantly.

Not in the MVP: push notifications (iOS schedules local notifications itself), real-time sync or WebSockets, social features, an admin API (use SQL directly), and a general sync endpoint.

## Stack

- **TypeScript on Node.js 22 LTS**
- **Hono** with `@hono/zod-openapi`. Each route's schema is written once in Zod, and the OpenAPI 3.1 spec is generated from it.
- **Zod** validates requests, AI output and config.
- **PostgreSQL 17**, with **Drizzle ORM and drizzle-kit**. Migrations are plain SQL.
- **pg-boss** for background jobs and cron. There is no Redis.
- **Auth:** Sign in with Apple (the server verifies the ID token with `jose`) or email + password (scrypt via `node:crypto`; the email is format-checked only, with no verification email in the MVP). Email and Apple accounts are separate. Either way the server issues its own JWT access token (15 min) and a rotating refresh token.
- **AI:** Qwen through Alibaba Cloud Model Studio's OpenAI-compatible endpoint (`openai` SDK with a custom `baseURL`), behind an `AiProvider` interface. Claude and OpenAI aren't available in mainland China or Hong Kong, so nothing outside `src/ai/` may depend on a specific provider.
- **pino** for JSON logs. Every log line includes the request ID.
- **Vitest** for tests, with **Testcontainers** for a real Postgres. Don't mock the database in ledger or transaction tests.
- **Docker / Docker Compose** (Caddy, api, worker, postgres). MVP deployment is a single server on Alibaba Cloud Hong Kong. Push images to Alibaba Container Registry (Docker Hub is unreliable from mainland China).

## Layout

```
src/
├── rules/      # pure 20-min / grace / Cadenza overlap / cascade / token logic: NO I/O, no DB, no clock
├── routes/     # Hono routes + Zod-OpenAPI schemas
├── services/   # events, recording, ledger, goals, cues
├── ai/         # AiProvider interface, qwen.ts (claude.ts later)
├── jobs/       # pg-boss workers
├── auth/       # Apple token verification, email/password, JWT, refresh rotation
└── db/         # Drizzle schema + migrations
test/
Dockerfile
package.json
```

The API and the worker are built from the same image, with separate entry points (`dist/server.js` and `dist/worker.js`). The generated `openapi.yaml` is committed under `contracts/`. The iOS client (`swift-openapi-generator`) and the web client (`openapi-typescript`) are generated from it, so regenerate and commit it whenever a route changes.

## Core rules (summary; the full version is in spec §3)

- **Kinds:** every event has `kind` `cadenza` or `tutti`. Both sit on the grid and last whole bars. Only Cadenzas are started, extended, finished, rewarded, pushed by cascades or checked for overlap; start/extend/finish on a Tutti returns `409 not_cadenza`. Tuttis are only ever `planned` or `cancelled`. A planned event can switch kind with `PATCH` (switching to Cadenza runs the overlap check; a started, done or missed Cadenza can't switch: `409 invalid_state`).
- **Grid:** 1 bar = 20 minutes. Grid marks are :00, :20 and :40. All times are stored as UTC `timestamptz`, along with the user's IANA time zone. Only **whole-hour UTC offsets** are supported, so all grid math runs in UTC. Half-hour and 45-minute zones (India, Nepal and others) must be reported as unsupported.
- **Snap:** `snap(t)` is the grid mark `g` with `g − 15 min < t ≤ g + 5 min`. The same window applies everywhere, with a 5-minute grace.
- **Start:** `recorded_start = snap(tap)`. The planned end doesn't move. An early start of up to 2 bars is allowed; more than that is rejected, as is one that would overlap another Cadenza. Snapping to or past the end counts as **missed**.
- **Finish:** a tap in `(E−15, E+5]` records `E` (on time). An earlier tap records `snap(tap)` (**shortened**; later events are not moved). If nothing happens by `E+5`, the event is **auto-finished**, recorded at `E`, and one bar of reward is deducted. Auto-finish is a pg-boss job delayed to `E+5`, rescheduled whenever `E` changes. A finish that snaps to the recorded start or earlier counts as **abandoned**.
- **Extend:** adds whole bars, either during the Cadenza or from the end prompt. Later Cadenzas it runs into are **pushed later in a cascade** by the smallest shift that clears each overlap (each starts exactly at the previous one's new end, so gaps are used up first; stop at the first Cadenza that already clears). Tuttis never move. Everything happens in one transaction, and the response lists every moved Cadenza. `dry_run` returns a preview. The extension is rejected (`pushed_event_locked`) if a Cadenza that would be pushed is already in progress or done. Pushes past the user's `day_end_local_time` are allowed but come with a warning.
- **Overlap:** a **Cadenza never overlaps another Cadenza**; Tuttis overlap anything, without limit. Intervals are half-open `[start, end)`. Cues, and Cadenzas that are cancelled or missed, don't count. Checked on create, edit (including a kind switch) and early start. A violation returns `409 cadenza_overlap` with the sorted IDs of the conflicting Cadenzas.
- **Tokens (Cadenzas only):** `v × planned_bars_completed + 0.5v × early_bars + 0.5v × extended_bars_completed − v × auto_finished`, floored at 0. A late start loses only the missed bars, with no extra penalty. A missed Cadenza earns and costs nothing. Every parameter lives in a versioned `reward_rules` row, and each ledger entry records the rule version used. Tuttis and cues never earn tokens.
- **Cues** (reminders): any minute (not tied to the grid), no duration, no tokens. Repeats use RFC 5545 `RRULE`, expanded on the server with `rrule`. Per-occurrence state is keyed by the occurrence's original time. Edits apply to **this occurrence, this and following (split the series, linked by `series_id`), or all**.

## Rules for writing the code

- **`src/rules/` must stay pure.** It takes inputs and returns outputs: no `Date.now()`, DB or env access. It must pass every case in `vendor/Twenty/contracts/rules/fixtures.json` (groups: `snap`, `start`, `finish`, `tokens`, `extend`, `create`, `timezone`). Expected objects must match exactly, with no extra keys. Compare times as instants, not strings. Constants are imported from the fixture's `constants` (`src/rules/constants.ts`), never hard-coded; they are placeholders until the game design is final. `migrate` adds a new `reward_rules` version whenever the fixture's reward constants change.
- **The token ledger is append-only.** No UPDATE or DELETE; corrections are new entries. `users.token_balance` is a cached sum, updated **in the same transaction** as the ledger insert. `idempotency_key` is UNIQUE.
- Every write that changes state accepts an **`Idempotency-Key`** header. Retries must never pay out twice.
- Events use a `version` column for **optimistic locking**.
- The server stores raw device tap times and computes the recorded times itself. Offline taps are accepted if the device time is within 24 hours and the clock looks sane.
- **API shape:** REST + JSON under `/v1`. Errors use one format, `{ "error": { "code": "snake_case_code", "message": "..." } }`. List endpoints use cursor pagination and ETags. `GET /healthz` is the liveness check. The full endpoint list (about 30 endpoints) is in spec §5.1. `DELETE /v1/me` is required by App Store rules.
- **Scaling habits to build in now:** a stateless API (no in-memory sessions or local files), 12-factor config from env vars, **UUIDv7** primary keys, indexes on `events(user_id, planned_start)` and `token_ledger(user_id, created_at)`, and a request ID in every log line.
- **AI:** validate model output with Zod. Durations must be whole 20-minute bars; repair or reject anything else. Accepted items become Cadenzas unless the client sends `kind: tutti`. Breakdowns run as the background job `ai.breakdown` (the API returns `202`, then the client polls). Enforce a per-user daily limit on breakdown requests. Never expose API keys to clients.
- **Jobs:** `ai.breakdown`, `events.auto_finish` (delayed until `E+5`), `events.close_stale` (every 20 minutes; marks unstarted, past Cadenzas as `missed`; Tuttis are left alone), `db.backup` (nightly `pg_dump` to OSS).

## Working conventions

- Write and run tests for any change to rules, ledger or recording logic. Report failing tests honestly.
- Keep generated artifacts (`openapi.yaml`, Drizzle migrations) in sync with the code that produces them, and commit them together.
- Don't add infrastructure the spec rules out for the MVP (Redis, Kafka, Kubernetes, microservices) without asking.
