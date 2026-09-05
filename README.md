# Salon Voice AI Receptionist + CRM

A voice receptionist that answers the phone for a hair salon — it quotes prices, checks the
diary, books, moves and cancels appointments — backed by a CRM the staff use for the same data.

The voice agent is **a client of the CRM's HTTP API**, exactly like any third-party integration.
It holds no database credentials. That boundary is enforced by a build check, not by convention.

```
  browser (mic)  ──ws──▶  voice agent  ──https──▶  CRM API  ──▶  PostgreSQL
                          (stateful)               (stateless)
  staff browser  ─────────────────────https──────▶
```

## Documentation

| | |
|---|---|
| [`ARCHITECTURE.md`](./ARCHITECTURE.md) | Design, system and entity diagrams, conversation state machine, assumptions, and a log of every defect found in live use with the reasoning behind each fix |
| [`API.md`](./API.md) | Endpoint reference, error codes, idempotency and tenancy semantics |
| [`EXAMPLES.md`](./EXAMPLES.md) | Six real captured call transcripts — booking, unavailable time, cancel, reschedule, an API failure, and a correction |
| [`DEMO.md`](./DEMO.md) | Five-minute live demo script |
| [`PRODUCTION.md`](./PRODUCTION.md) | Limitations, scaling, monitoring, security, future improvements |
| [`SCALING.md`](./SCALING.md) | Infrastructure detail behind the production summary |
| [`AI_USAGE.md`](./AI_USAGE.md) | How AI coding tools were used, and what was reviewed |
| [`docs/openapi.json`](./docs/openapi.json) | Generated OpenAPI spec — also served at `/docs` |

---

## Prerequisites

| | Why |
|---|---|
| **Node.js 20.11+** (developed on 24) | Native `fetch`, `WebSocket` and `process.loadEnvFile`, so no polyfills or `dotenv` |
| **pnpm 9+** | Workspace linking for the monorepo. `npm i -g pnpm` |
| **Docker** | Runs PostgreSQL 16. Nothing else is containerised |

No API keys are needed to run the whole system, including live voice — see
[Running without any API keys](#running-without-any-api-keys).

## Setup

```bash
git clone https://github.com/ayushchd8/salon-voice-receptionist.git
cd salon-voice-receptionist
pnpm install
cp .env.example .env
```

`.env.example` has working defaults for local development; every setting is
documented inline. Nothing needs editing to get started.

```bash
pnpm db:up      # PostgreSQL 16 in Docker on port 5433, waits until it is accepting connections
pnpm migrate    # apply the schema
pnpm seed       # demo data — prints the API keys, copy the sk_staff_… one
```

`db:up` uses port **5433** rather than 5432 so it cannot collide with a
PostgreSQL you already have running.

```bash
pnpm dev        # all three services, prefixed output, one terminal
```

| What | Where |
|---|---|
| **Talk to the receptionist** | <http://localhost:4100> |
| **Staff CRM** | <http://localhost:5173> — sign in with the `sk_staff_…` key |
| **API reference** | <http://localhost:4000/docs> |

Start over at any point with `pnpm db:reset` (drops the volume, re-migrates,
re-seeds).

<details>
<summary>Running the services separately</summary>

```bash
pnpm dev:api     # CRM API        :4000
pnpm dev:agent   # voice agent    :4100
pnpm dev:admin   # staff CRM      :5173
```
</details>

## The stack, and why

Fuller rationale — including the trade-offs rejected — is in
[`ARCHITECTURE.md`](./ARCHITECTURE.md).

| Choice | Why this one |
|---|---|
| **TypeScript** everywhere | The Zod request/response schemas in `packages/contracts` are literally the same objects the agent validates against and the UI derives its types from. A second language would mean a hand-maintained copy of the API contract — the exact thing that rots. |
| **PostgreSQL 16** | The correctness core of this system is "two callers must not book the same slot". Postgres gives that as a database-level `EXCLUDE USING gist` constraint over `tstzrange`, plus real transactions for atomic reschedule. This is not a preference; it is why the concurrency requirement is satisfiable without a distributed lock service. |
| **Fastify 5** | Schema-first by design, so route schemas produce the OpenAPI document for free. Mature plugin scoping for the auth and rate-limit hook points, and roughly twice Express's throughput. |
| **Drizzle ORM** | Typed queries inferred from a TS schema, no codegen daemon or engine binary. Thin enough that dropping to raw SQL for the hard queries is normal rather than an escape hatch. |
| **Hand-written SQL migrations** | Deliberate deviation from `drizzle-kit generate`. The schema depends on `EXCLUDE USING gist`, `btree_gist`, partial-predicate constraints and composite foreign keys, none of which an ORM diff tool round-trips faithfully. Reviewable SQL is worth more here than generated SQL. A test reflects `information_schema` and fails the build if the TS and the SQL disagree. |
| **Zod** | One declaration produces runtime validation, static types, *and* the published spec, so the documented contract cannot drift from the enforced one. |
| **Luxon** | Opening hours are salon-local wall clock; appointments are absolute instants. Getting that wrong breaks twice a year at daylight-saving boundaries, so the conversion lives in one tested module rather than scattered `Date` arithmetic. |
| **React + Vite + TanStack Query** | Server-state caching, retries and rollback are what a CRM UI actually needs; hand-rolling them is where prototype UIs go wrong. Plain CSS — functional over polished, as scoped. |
| **WebSocket + browser voice** | Exercises the whole pipeline — real microphone, real recognition, real barge-in, real synthesized speech — with no telephony account. Twilio is the documented production path. |
| **Anthropic Claude** for dialogue | Strict tool schemas mean tool input always validates, so the executor never receives a half-formed booking. A deterministic `scripted` adapter stands in when no key is set, which also makes the conversation flows testable without paying per run. |
| **Vitest** + real PostgreSQL | The behaviour under test *is* PostgreSQL behaviour. Mocking the database would leave the tests asserting that the mock does what the mock was told to do. |
| **pnpm workspaces** | Three apps and two shared packages, with the architectural boundary between them enforced by a build check rather than by convention. |

### Why it is split into five packages

```
packages/contracts   Zod schemas, error codes, scopes — the API contract, shared by all three apps
packages/core        Pure domain engine: availability, booking policy, time. Zero I/O.
apps/api             CRM API — the only process with database credentials
apps/agent           Voice agent + browser voice client
apps/admin           Staff CRM (React)
```

Two of those splits are load-bearing rather than tidiness:

- **`packages/core` has no I/O.** The availability engine and every policy rule
  are pure functions over plain data, so they are testable against fixtures with
  no database and no clock — and the same code that *offers* a slot is the code
  that *validates* the booking of it. There is one implementation of "is this
  slot legal", so availability and booking cannot drift apart.
- **`apps/agent` and `apps/admin` hold no database credentials.** They reach the
  CRM only over its published HTTP API, exactly as a third-party integration
  would. `pnpm test:boundaries` fails the build if either acquires a database
  driver, imports CRM internals, or reads `DATABASE_URL`.

## Running without any API keys

The demo is designed to work before you have signed up for anything:

| Piece | Zero-key default | Production option |
|---|---|---|
| Speech in | Web Speech API, in the caller's browser | Deepgram streaming (`STT_PROVIDER=deepgram`) |
| Speech out | `SpeechSynthesis`, in the caller's browser | Cartesia or ElevenLabs |
| Dialogue | A deterministic rule-based policy | Anthropic Claude (`ANTHROPIC_API_KEY`) |
| Telephony | Browser microphone | Twilio number → media stream |

The audio pipeline is genuinely real in the zero-key configuration — microphone, recognition,
turn-taking, barge-in and synthesized speech all work. Only the *dialogue policy* is
substituted, and the substitution is visible in the client's header so nobody is misled about
what they are hearing.

**For real dialogue**, set `ANTHROPIC_API_KEY` in `.env` and restart. The agent uses
`claude-opus-5` with adaptive thinking at low effort — voice is latency-sensitive, and low
effort keeps turns quick without disabling thinking (which risks tool calls leaking into
spoken text).

Speech recognition needs Chrome or Edge. In other browsers the client falls back to a text
box; everything behind it — tools, state machine, guards — is identical.

---

## Try the demo

Open <http://localhost:4100>, click **Start call**, then hold the mic button and speak. The
panel on the right shows every tool call, state transition and guard trip as it happens.

**[`DEMO.md`](./DEMO.md) is a five-minute guided walkthrough** covering all of the below plus a
deliberate database failure. [`EXAMPLES.md`](./EXAMPLES.md) has the same conversations as real
captured transcripts if you would rather read than run.

The demo caller ID is Eleanor's number, so she is recognised by name. Things worth trying:

| Say | What it exercises |
|---|---|
| *"What time do you open on Saturday?"* | FAQ answered from live data, not a script |
| *"How much is a full head colour?"* | Service menu with real prices |
| *"Can I book a cut and blow dry next Friday afternoon?"* | Fuzzy time → concrete slots |
| *"Do you have anything at 9am on Sunday?"* | Closed day → concrete alternatives offered |
| *"I need to cancel my appointment"* | **Eleanor has two — the agent must ask which** |
| *"Actually, make it a colour instead"* | Mid-conversation correction |
| *"I want a refund, the colour was ruined"* | Out of scope → callback captured, escalated |

Then open the CRM's **Call review** screen: every call above is there with its intent, outcome,
transcript and the agent's full tool trail — including the ones that failed.

---

## Commands

| Command | What it does |
|---|---|
| `pnpm dev` | All three services, prefixed output, one terminal |
| `pnpm dev:api` / `dev:agent` / `dev:admin` | One service |
| `pnpm db:up` / `db:down` / `db:reset` | PostgreSQL lifecycle |
| `pnpm migrate` / `pnpm seed` | Schema and demo data |
| `pnpm test` | All 259 tests |
| `pnpm test:unit` | Domain engine only — no database needed |
| `pnpm test:integration` | CRM API against real PostgreSQL |
| `pnpm test:agent` | Conversation flows against a controllable fake CRM |
| `pnpm test:boundaries` | Fails if the agent or UI gains database access |
| `pnpm lint` · `pnpm typecheck` | ESLint · project-wide `tsc` |
| `pnpm check` | Everything above, in CI order |
| `pnpm openapi` | Regenerate `docs/openapi.json` |

### Tests

```bash
pnpm db:up && pnpm check
```

259 tests across three levels, each at the boundary where it belongs:

- **88 unit tests** (`packages/core`) — availability, buffers, policy, DST, fuzzy time, phone
  normalisation. Pure functions over fixtures; no database, no clock.
- **60 integration tests** (`apps/api`) — against real PostgreSQL, because the behaviour under
  test *is* PostgreSQL behaviour. Includes an eight-way concurrent booking race asserting that
  exactly one wins, and schema-drift checks that the Drizzle types still match the SQL.
- **111 conversation tests** (`apps/agent`) — the full agent over real HTTP against a CRM that
  can be told to time out, fail once, or lose a slot mid-conversation.

The integration suite uses a separate `salon_test` database, created automatically.

---

## Sample data

`pnpm seed` creates a fully configured demo salon: weekly opening hours, holiday
closures, a service menu with durations, buffers and prices, staff with
different competencies and shifts, customers, existing appointments and a short
call history so the CRM's review screen has something in it from the start.

It is idempotent — re-running it rebuilds the demo data from scratch — and it
prints the API keys it created. They are stored as hashes, so those printed
values are the only copy.

One customer is deliberately seeded with **two** upcoming appointments, so that
"cancel my appointment" has to be disambiguated rather than guessed at.

## Configuration

Everything is in `.env` (see `.env.example`, which documents each setting). Nothing is
hardcoded and no secret is committed.

Before deploying anywhere real, replace `SESSION_SECRET` with 32 random bytes:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

API keys are stored as SHA-256 hashes; the raw values are printed once by `pnpm seed` and
never persisted. The voice agent and the staff UI hold separate credentials with different
scopes, revocable independently — revoking the agent's key silences the phone line without
logging staff out.

## Multi-tenancy

Every salon-scoped table carries `salon_id`, and `salon_id` is derived from the
authenticated credential rather than accepted from a request — so a caller
cannot reach another salon's data by changing a parameter, and a forgotten
`WHERE` clause cannot leak across tenants. The database enforces it again with
composite `(id, salon_id)` foreign keys, which make a cross-tenant reference
impossible at the storage layer.

Onboarding another salon is therefore rows, not code: hours, closed dates,
services, staff, booking policy and a pair of API keys. No branch anywhere in
the codebase reads a salon name or slug. The tenancy-isolation tests in
`apps/api/src/routes/lifecycle.test.ts` verify this by trying to cross the
boundary with a valid credential and expecting a 404.
