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

## Requirements

| | |
|---|---|
| Node.js | 20.11+ (developed on 24) |
| pnpm | 9+ |
| Docker | for PostgreSQL 16 |

No API keys are required to run the whole system, including live voice. See
[Running without any API keys](#running-without-any-api-keys).

## Quick start

```bash
pnpm install
cp .env.example .env

pnpm db:up          # PostgreSQL 16 in Docker, waits until it is accepting connections
pnpm migrate        # apply schema migrations
pnpm seed           # two demo salons, staff, customers, appointments, call history

pnpm dev            # API :4000 · voice agent :4100 · CRM UI :5173
```

`pnpm seed` prints the demo API keys. Then:

| What | Where |
|---|---|
| **Talk to the receptionist** | <http://localhost:4100> |
| **Staff CRM** | <http://localhost:5173> — sign in with the `sk_staff_…` key |
| **API reference** | <http://localhost:4000/docs> |

To start over: `pnpm db:reset`.

---

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
| `pnpm test` | All 256 tests |
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

256 tests across three levels, each at the boundary where it belongs:

- **88 unit tests** (`packages/core`) — availability, buffers, policy, DST, fuzzy time, phone
  normalisation. Pure functions over fixtures; no database, no clock.
- **60 integration tests** (`apps/api`) — against real PostgreSQL, because the behaviour under
  test *is* PostgreSQL behaviour. Includes an eight-way concurrent booking race asserting that
  exactly one wins, and schema-drift checks that the Drizzle types still match the SQL.
- **108 conversation tests** (`apps/agent`) — the full agent over real HTTP against a CRM that
  can be told to time out, fail once, or lose a slot mid-conversation.

The integration suite uses a separate `salon_test` database, created automatically.

---

## Repository layout

```
packages/contracts   Zod schemas, error codes, scopes — shared by all three apps
packages/core        Pure domain engine: availability, policy, time. No I/O.
apps/api             CRM API — the only process with database credentials
apps/agent           Voice agent + browser voice client
apps/admin           Staff CRM (React)
```

`pnpm test:boundaries` fails the build if `apps/agent` or `apps/admin` acquires a database
driver, imports CRM internals, or reads `DATABASE_URL`; and if `packages/core` acquires I/O.

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

## Adding a second salon

No code changes. `pnpm seed` already creates two: **Luxe Hair Studio** (London, GBP, closed
Sundays) and **Bella Beauty Bar** (New York, USD, closed Mondays, 24-hour notice, 48-hour
cancellation window, 30-minute slots). Every salon-scoped table carries `salon_id`, and
`salon_id` is derived from the authenticated credential rather than accepted from a request —
so a caller cannot reach another salon's data by changing a parameter. The tenancy-isolation
tests try exactly that.
