# Taking this to production

What this prototype already does correctly, what it deliberately does not, and what changes
between one salon on a laptop and a few thousand salons taking real calls.

---

## 1. What already scales, and why

Three decisions do most of the work, and they are all in place:

**The overlap guarantee is in the database.** `EXCLUDE USING gist` over
`tstzrange(block_start, block_end)` means two concurrent bookings for the same slot are
serialised by Postgres, not by application code. This keeps working when the API runs on twenty
nodes, because correctness never depended on there being one node. There is no distributed lock
to add later, and no check-then-write window to discover under load.

**Tenancy is data, not code.** Every salon-scoped table carries `salon_id`; `salon_id` comes
from the credential, never from a request; and composite `(id, salon_id)` foreign keys make a
cross-tenant reference impossible at the storage layer. Onboarding salon #3,000 is rows.

**The agent is a client.** It reaches the CRM only over the published HTTP API, enforced by
`pnpm test:boundaries`. So the API and the agent scale independently, and a second consumer
(a web booking widget, a partner integration, a WhatsApp bot) needs no new access path.

---

## 2. Horizontal scaling

### CRM API — stateless, scale flat

No in-process state except a five-second API-key cache. Run *n* replicas behind a load
balancer.

- **Same-slot concurrency sets a floor on pool size.** Concurrent bookings of one slot are
  serialised by the exclusion constraint, and a blocked `INSERT` holds its connection until its
  turn comes. So *N* simultaneous attempts on one slot occupy *N* connections for the duration.
  Size the pool above realistic same-slot contention (`DB_POOL_MAX`), and make sure genuine
  contention — deadlock, lock timeout, pool exhaustion — maps to a retryable
  `SERVICE_UNAVAILABLE` rather than a bare 500; the agent already retries the former with the
  same idempotency key.
- **Connection pooling is the first ceiling.** Twenty pool connections per replica × forty
  replicas exhausts a default Postgres `max_connections` long before CPU matters. Put
  **PgBouncer** in transaction pooling mode in front of it. Two consequences to design for:
  session-level features (advisory locks, prepared statements, `SET LOCAL`) stop being safe —
  this codebase uses none, which is not an accident.
- **Read replicas** for the read-heavy paths: availability, service menus, call-summary review.
  Availability is the hottest query and is already a bounded range scan on
  `(salon_id, start_time)`. Booking must stay on the primary — the exclusion constraint is only
  meaningful there.
- **Replace the key cache with Redis** so revocation is immediate fleet-wide rather than within
  five seconds per node.

### Voice agent — stateful, scale with affinity

Each live call holds a `CallSession` in memory, so a call must stay on the worker that owns it.

- **Sticky routing** by `callId`. For Twilio, the media stream connects once and stays; route on
  the WebSocket upgrade.
- **Session state to Redis**, keyed by `callId`, written on every state transition. `CallSession`
  is already a plain serialisable object with no behaviour, precisely so this is a persistence
  change rather than a redesign. That buys worker restarts mid-call and lets a supervisor
  inspect a live call.
- **Capacity is bounded by concurrent calls, not throughput** — a call is minutes of mostly
  waiting. Autoscale on active WebSocket count, not CPU. Budget generously for the LLM/STT/TTS
  provider rate limits, which will bind before your own compute does.
- **Drain properly.** The agent already writes a call summary for every in-flight call on
  `SIGTERM`. Give pods a termination grace period longer than a typical call, and stop routing
  new calls at the start of the drain rather than the end.

### Database

Order of moves as load grows:

1. Indexes and query shape — already done for the known access patterns.
2. Read replicas for availability and reporting.
3. Partition `appointments` and `call_logs` by month. Both are append-heavy and almost always
   queried by recent date range; `call_logs` in particular grows without bound because it holds
   transcripts.
4. Move transcripts and recordings out of Postgres to object storage, leaving a reference.
   `call_log.recording_ref` already exists for this.
5. Shard by `salon_id` only if a single primary genuinely stops coping. Because tenancy is
   already a column on every table and never a join key across tenants, this is a routing change
   rather than a schema change — but it is a big operational step and should be the last one.

---

## 3. Concurrent calls

| Concern | Now | Production |
|---|---|---|
| Two callers, one slot | Database exclusion constraint | Unchanged — this is the durable answer |
| Two calls from the same number | Independent sessions | Unchanged; the per-customer cap limits abuse |
| Agent retry after a timeout | Idempotency key minted at staging, reused on every retry | Unchanged |
| Provider rate limits | Per-request timeouts, bounded retries | Add a global concurrency limiter per provider, and shed load by telling callers the line is busy rather than degrading everyone's calls |
| Cost per call | Not measured | Track LLM/STT/TTS spend per call; the `CallSummary.events` trail already carries the tool-call timings to attribute it |

---

## 4. Real telephony

The Twilio path is written to the interface and **unverified** — it needs an account, a number
and a public endpoint. What it needs to become real:

1. A number per salon, mapping inbound `To` → `salon_id`, replacing the single agent credential
   with a per-salon key lookup.
2. `POST /twilio/voice` returns TwiML opening a bidirectional Media Stream; the stream handler
   transcodes µ-law 8 kHz ↔ PCM and emits the same normalised events the browser client
   produces. **This is the reason `CallRunner` and every guard above it are transport-independent
   — adding a phone number changes no conversation logic.**
3. Server-side STT becomes mandatory: a phone line has no browser to run the Web Speech API in.
   The Deepgram adapter exists for this.
4. Validate the `X-Twilio-Signature` header on the webhook. Not doing so lets anyone start calls
   at your expense.
5. Server-side TTS becomes mandatory too, streamed back as µ-law media frames.
6. Barge-in moves to server-side VAD on the inbound frames; the session logic is unchanged
   because it consumes normalised events.

Telephony-specific work that has no browser equivalent: DTMF handling, answering-machine
detection, call recording with two-party-consent rules per jurisdiction, and a fallback that
forwards to a human when the agent service is unhealthy — a phone line that rings out is worse
than one that never claimed to be answered.

---

## 5. Onboarding a new salon

Today, entirely data:

```
salons → business_hours (7 rows) → booking_policies (1 row)
       → services → staff_members → staff_services → staff_working_hours
       → api_keys (agent + staff)
```

`pnpm seed` does exactly this twice, for salons that differ in timezone, currency, opening days,
notice periods, cancellation windows and slot granularity. No branch anywhere in the codebase
reads a salon slug.

For self-service onboarding, add: a signup flow writing those rows, per-salon Twilio number
provisioning, a template library ("hair salon", "nail bar") to pre-fill the service menu, and a
staged rollout — agent answers overflow calls only, then out-of-hours, then everything — because
the first week of a voice agent on a real line is when you find out what your callers actually
say.

## 6. Swapping the scheduling backend

Salons that already run Fresha, Treatwell or Booksy will not migrate their diary. The seam is
`packages/core` plus the repository layer: the availability engine is pure and takes plain data,
so an adapter that fetches hours, staff and busy blocks from a third-party API and writes
bookings back through it slots in without touching the conversation logic, the API contract, or
the CRM UI. What changes is that the overlap guarantee moves to *their* system — which is the
real cost of the swap, and worth being explicit about rather than discovering later.

---

## 7. CI/CD

The pipeline is already expressible as `pnpm check`: lint → typecheck → boundaries → 259 tests.

What to add:
- Postgres service container for the integration suite (already parameterised via
  `TEST_DATABASE_URL`).
- Migrations run as a separate, gated step before the app deploys. They are forward-only and
  checksummed — editing an applied migration is a hard error, not a silent no-op.
- Expand/contract for schema changes: add nullable, backfill, switch reads, then drop. Never
  ship a migration that requires the old code to be gone.
- A smoke test after deploy that books and cancels a real appointment in a canary salon.
- Publish `docs/openapi.json` on each release and diff it — an unintended contract change should
  fail review, not surprise the agent.

## 8. Secrets

`.env` is fine for one developer and nothing else. Use a managed secret store (AWS Secrets
Manager, Vault, Doppler) with per-environment scoping and rotation. Nothing here needs code
changes: every secret is already read from the environment at startup and validated by a schema
that fails loudly on boot rather than at the first request.

Rotation is already survivable: API keys are hashed rows with `revoked_at`, so issuing a new key
and revoking the old is two writes and no downtime.

## 9. Observability

Present:

- Structured JSON logs, PII-redacted, correlated by `request_id`, `call_id` and `salon_id`. One
  `call_id` reconstructs a whole call from agent turn to database write.
- Per-call structured event trails persisted in `call_summaries.events`, with tool-call latency
  and outcome.
- `/health` and `/ready`.

For production:

| | |
|---|---|
| **Traces** | OpenTelemetry spanning agent turn → tool call → API request → query. Propagate `X-Call-Id` as a trace baggage item. |
| **Metrics** | Booking success rate; availability p95; turn latency p50/p95 split by LLM/STT/TTS/CRM; escalation rate; idempotent-replay rate; call abandonment. |
| **Alerts** | Booking success rate dipping below baseline; escalation rate spiking; `/ready` failing; CRM p95 approaching the agent's 8-second timeout. |
| **Page immediately** | **Any non-zero rate of the no-false-success guard tripping.** A trip means the model tried to tell a customer something was booked when it was not. The guard catches it, but a non-zero rate is a prompt or model regression that needs a human the same day. |
| **Review queue** | Escalated calls, and calls where a write outcome was `unknown` — those are the ones where a customer may be holding a booking nobody can confirm. |

## 10. Known gaps

Honest list of what a real deployment needs that this does not have:

- **No payments.** Cancellation and no-show fees are recorded as amounts owed; nothing charges
  them. A deposit-taking flow would need PCI scope, which is a project of its own.
- **One service per appointment.** The model supports a join-table extension, but the booking
  flow, availability engine and voice confirmation are single-service. This is the first schema
  extension a real salon would ask for ("cut and colour together").
- **Caller ID is trusted for lookup, not verified.** Anyone calling from a known number can see
  and change that customer's appointments — the same trust model as a receptionist with caller
  ID. Fine for haircuts; add verification before anything sensitive.
- **No recurring appointments, waitlists, or resource booking** (a chair, a basin, a colour
  bar). Resources would extend the same exclusion-constraint pattern.
- **Phone normalisation is hand-rolled** for a handful of country codes. Swap in
  libphonenumber before going international; the seam is one function.
- **The demo browser client hardcodes a caller ID** so a returning customer is recognised. Real
  telephony supplies it.
- **Accessibility and i18n of the CRM UI** have not been worked on.
