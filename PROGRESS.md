# Build Progress

Phase-by-phase TODO tracking. Each phase is independently runnable and checked
against its Definition of Done before the next one starts.

## Phase 0 — Scaffold, tooling, env, scripts
- [x] pnpm workspace monorepo (`packages/contracts`, `packages/core`, `apps/{api,agent,admin}`)
- [x] TypeScript project references + strict config
- [x] `docker-compose.yml` — Postgres 16 on host port 5433
- [x] `.env.example` + `.env` bootstrap
- [x] ESLint flat config, Vitest workspace config
- [x] `scripts/wait-for-db.mjs`, `scripts/dev.mjs` (all three services, one terminal)
- [x] `scripts/check-boundaries.mjs` — architectural fitness function
- [x] Dependencies installed, database reachable

## Phase 1 — Data model, migrations, seed
- [x] SQL migrations (schema, constraints, indexes)
- [x] `btree_gist` exclusion constraint proving no overlapping bookings
- [x] Composite `(id, salon_id)` FKs — cross-tenant references impossible
- [x] Drizzle schema for typed queries
- [x] Migration runner + `schema_migrations` checksum tracking
- [x] Seed: Luxe Hair Studio (London/GBP) + Bella Beauty Bar (New York/USD),
      different hours, services, policies — onboarding proven config-only
- [x] 88 unit tests over the pure domain engine (availability, policy, time, phone)

## Phase 2 — CRM API
- [x] Auth: SHA-256 hashed API keys, scopes, staff session-cookie exchange
- [x] Error contract (closed code enum) + field-level validation
- [x] Idempotency middleware (reserve-commit-work, replay, reuse detection, stale takeover)
- [x] Customers, Services, Staff, Hours, Policies, Availability, Appointments, Calls
- [x] OpenAPI spec — 35 operations at `docs/openapi.json`, UI at `/docs`
- [x] 40 integration tests, including an 8-way concurrent booking race

## Phase 3 — CRM Admin UI
- [x] Session login (staff key exchanged for an httpOnly cookie)
- [x] Appointments diary — book, move, cancel, mark done / no-show
- [x] Customers — search, create, edit, appointment + call history
- [x] Services — create, edit, retire/restore
- [x] Hours & closures — weekly grid, holidays, special hours
- [x] Booking policy — every knob, with what each one does to a caller
- [x] Call review — filter by outcome/escalation, transcript + agent event trail
- [x] All of it through the HTTP API; no database access in the app

## Phase 4 — Voice agent
- [x] Explicit session state machine; tools gated by state
- [x] Tool layer owns the truth about what happened; staging vs committing
- [x] LLM (Anthropic + scripted), STT (browser/Deepgram), TTS (browser/Cartesia/ElevenLabs)
- [x] Browser voice client with real mic, speech recognition, synthesis and barge-in
- [x] Twilio transport written to the interface (unverified — no account)

## Phase 5 — Reliability hardening
- [x] Idempotency key minted at staging, reused across retries
- [x] 8-way concurrent booking race — exactly one winner
- [x] Timeouts + bounded retries with jitter on every external call
- [x] Confirmation gating enforced by tool availability, not prompt text
- [x] Output guards: no false success, no PII leakage, no runaway tool loops

## Phase 6 — Call outcomes, observability, tests, docs
- [x] Structured call summary written for every call, in a `finally` block
- [x] JSON logs with request_id / call_id / salon_id correlation and PII redaction
- [x] 255 tests: 88 unit · 60 integration · 107 conversation
- [x] README, ARCHITECTURE, API, SCALING, generated OpenAPI

---

**Status: all phases complete.** `pnpm check` is green: lint, typecheck, architectural
boundaries and 255 tests.
