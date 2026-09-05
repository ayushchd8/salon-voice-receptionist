# Production readiness

An honest assessment of what this is, what it is not, and what standing it up for
real callers would take. [`SCALING.md`](./SCALING.md) covers the infrastructure
mechanics in more depth; this is the summary a reviewer or an on-call engineer
needs.

**What it is:** a working prototype with the correctness-critical parts built to
production standards — the concurrency guarantee, the tenancy model, the
idempotency layer and the agent's safety guards are all things I would defend
unchanged in a design review. **What it is not:** a deployable product. The
telephony path is unverified, there is no payment handling, and the operational
surface (tracing, alerting, secret management) is designed but not wired up.

---

## 1. Limitations

Known gaps, roughly in the order a real deployment would hit them.

| Limitation | Consequence | Effort to close |
|---|---|---|
| **Telephony is unverified.** The Twilio webhook and media-stream handler are written to the interface but need an account, a number and a public endpoint to exercise. | Browser voice is the only tested transport. | Days. The transport already normalises to the same events, so no conversation logic changes. |
| **One service per appointment.** The schema supports a join-table extension; the booking flow, availability engine and voice confirmation are single-service. | "Cut *and* colour together" cannot be booked as one appointment. | ~1 week. First thing a real salon asks for. |
| **Caller ID is trusted for lookup, not verified.** Anyone calling from a known number can see and change that customer's appointments. | Same trust model as a receptionist with caller ID — fine for haircuts, not for anything sensitive. | Small, but needs a product decision about the friction. |
| **No payments.** Cancellation and no-show fees are recorded as amounts owed; nothing charges them. | Fees are advisory. | Significant — PCI scope is a project of its own. |
| **No recurring appointments, waitlists, or resource booking** (a chair, a basin, a colour bar). | Common salon workflows unsupported. Resources would extend the same exclusion-constraint pattern. | ~2 weeks. |
| **Phone normalisation is hand-rolled** for a handful of country codes. | Breaks outside the supported set. | Hours — swap in libphonenumber; the seam is one function. |
| **The demo browser client hardcodes a caller ID** so a returning customer is recognised. | Every browser call is "Eleanor". Real telephony supplies the number. | Trivial. |
| **No accessibility or i18n work** on the staff CRM. | Not suitable for a real salon's front desk as-is. | Ongoing. |
| **Rate limiting is permissive** and keyed per credential, not per caller. | A compromised agent key could hammer the API. | Hours — the hook point is registered and configured. |

### Where the dialogue is weakest

The default policy when no `ANTHROPIC_API_KEY` is set is a **rule-based keyword
matcher**, not a language model. It handles the demo paths and everything in
[`EXAMPLES.md`](./EXAMPLES.md), but unusual phrasings will find its edges — most
of the conversational bugs found during testing were in it. It exists so the
system runs end to end with no credentials and so the conversation flows can be
tested deterministically. **Production would run the Anthropic adapter**, which
drives exactly the same tools, state machine and guards.

---

## 2. Scaling

Full detail in [`SCALING.md`](./SCALING.md). The short version:

**What already scales.** The overlap guarantee is a database constraint, not
application logic, so it keeps working on twenty nodes — there is no distributed
lock to add later. Tenancy is a column on every table with `salon_id` derived
from the credential, so onboarding salon #3,000 is rows, not code. The agent
reaches the CRM only over HTTP, so the two scale independently.

**The CRM API is stateless** — scale flat behind a load balancer, put PgBouncer
in transaction-pooling mode in front of Postgres, and move read-heavy paths
(availability, service menus, call review) to read replicas. Booking must stay on
the primary; the exclusion constraint is only meaningful there.

**The voice agent is stateful** — each live call holds a session in memory, so
calls need sticky routing by `callId`. `CallSession` is a plain serialisable
object precisely so moving it to Redis is a persistence change rather than a
redesign. Autoscale on active WebSocket count, not CPU: a call is minutes of
mostly waiting.

**The first real ceiling is the connection pool, not CPU.** Concurrent bookings
of one slot serialise on the exclusion constraint, and a blocked `INSERT` holds
its connection while it waits — so *N* simultaneous attempts on one slot occupy
*N* connections. `DB_POOL_MAX` must exceed realistic same-slot contention. This
is not theoretical: it surfaced as an intermittently failing concurrency test.

**Database growth order:** indexes (done) → read replicas → partition
`appointments` and `call_logs` by month → move transcripts and recordings to
object storage → shard by `salon_id` only if a single primary genuinely stops
coping.

---

## 3. Monitoring

**In place today**

- Structured JSON logs (pino), PII-redacted by path, correlated by `request_id`,
  `call_id` and `salon_id`. One `call_id` reconstructs a whole call: agent turn →
  tool call → API request → database write.
- Per-call structured event trails persisted in `call_summaries.events`, with
  tool-call latency and outcome. Visible in the CRM's call-review screen.
- `/health` (liveness) and `/ready` (readiness, including the database — returns
  503 so a failing dependency drains traffic instead of triggering a restart
  loop).

**What to add before taking real calls**

| | |
|---|---|
| **Traces** | OpenTelemetry spanning agent turn → tool call → API request → query, propagating `call_id` as baggage. |
| **Metrics** | Booking success rate; availability p95; turn latency p50/p95 split by LLM/STT/TTS/CRM; escalation rate; idempotent-replay rate; call abandonment; cost per call. |
| **Alerts** | Booking success rate below baseline; escalation rate spike; `/ready` failing; CRM p95 approaching the agent's 8-second timeout. |
| **Page immediately** | **Any non-zero rate of the no-false-success guard tripping.** A trip means the model tried to tell a customer something was booked when it was not. The guard catches it, but a non-zero rate is a prompt or model regression that needs a human the same day. |
| **Human review queue** | Escalated calls, and calls where a write outcome was `unknown` — those are customers who may be holding a booking nobody can confirm. |

---

## 4. Security

**In place**

- **Secrets** via environment variables only, validated by schema at boot so a
  missing one fails loudly rather than at the first request. `.env.example` is
  committed with empty placeholders; no real credential is in the repository.
- **API keys stored as SHA-256 hashes.** The raw value is shown once at seed time
  and never persisted, so a database dump contains no usable credentials.
- **Two credential classes, independently scoped and revocable.** Revoking the
  agent key silences the phone line without logging staff out. The agent's key
  deliberately lacks `customers:read:full`.
- **Tenancy cannot be broken by a parameter.** `salon_id` is derived from the
  credential, never accepted from a request, and composite `(id, salon_id)`
  foreign keys make a cross-tenant reference impossible at the storage layer.
- **PII minimisation is enforced by the serializer, not by prompt.** Customer
  records reaching the agent are projected down to `{id, firstName, phone}` —
  it is structurally incapable of reciting a customer's staff notes because it
  never receives them. A second output guard catches sensitive phrasing.
- **Staff sessions use a signed httpOnly cookie**, exchanged from the API key at
  login, so a long-lived credential never sits in browser storage. The key row is
  re-read per request, so revocation ends live sessions immediately.
- **Log redaction** on phone, email and notes paths; identifiers are logged, not
  values.
- **Input validation** on every endpoint via Zod, with parameterised queries
  throughout (no string-built SQL anywhere).

**Before production**

- Move secrets to a managed store (Vault, AWS Secrets Manager, Doppler) with
  per-environment scoping and rotation. Nothing needs code changes.
- **Validate `X-Twilio-Signature`** on the telephony webhook — without it, anyone
  can start calls at your expense.
- Replace the seeded demo keys, and generate a real `SESSION_SECRET`.
- HTTPS termination, HSTS, and a tightened CORS origin list.
- Add audit logging for staff actions (who cancelled what, and when).
- Decide the retention policy for transcripts and recordings, and note that call
  recording is subject to two-party-consent law in many jurisdictions — the
  prototype stores no audio, which side-steps this deliberately.
- A dependency and container scan in CI.

---

## 5. Future improvements

**Would do first**

1. **Wire up the Anthropic adapter as the default path** and run an evaluation
   set over real transcripts. The harness is built; what is missing is measured
   quality.
2. **Verify telephony end to end** with a real number, including DTMF,
   answering-machine detection and a failover that forwards to a human when the
   agent service is unhealthy — a line that rings out is worse than one that
   never claimed to be answered.
3. **Multi-service appointments**, the first thing a real salon will ask for.
4. **Session state to Redis**, so a worker restart does not end a call.

**Then**

5. Barge-in tuning with server-side VAD, and latency work on the
   STT → LLM → TTS path; perceived quality on a phone call is mostly latency.
6. Deposits and no-show charging.
7. Self-service salon onboarding — signup writes the rows, provisions a number,
   pre-fills a service menu from a template.
8. A staged rollout mode: agent answers overflow only, then out-of-hours, then
   everything. The first week on a real line is when you learn what callers
   actually say.
9. Swap the scheduling backend for an incumbent (Fresha, Treatwell, Booksy) via
   the `packages/core` seam — being explicit that this moves the overlap
   guarantee into *their* system, which is the real cost of the swap.

---

## Test and quality posture

`pnpm check` is the pipeline: lint → typecheck → architectural boundaries → 256
tests.

| Level | Count | Runs against |
|---|---|---|
| Unit | 88 | Pure domain engine — availability, buffers, policy, DST, fuzzy time, phone normalisation. No database, no clock. |
| Integration | 60 | Real PostgreSQL, because the behaviour under test *is* PostgreSQL behaviour. Includes an eight-way concurrent booking race and schema-drift reflection. |
| Conversation | 108 | The full agent over real HTTP against a CRM that can be told to time out, fail once, or lose a slot mid-conversation. |

`pnpm test:boundaries` is an architectural fitness function: it fails the build
if the voice agent or the staff UI acquires a database driver, imports CRM
internals, or reads `DATABASE_URL`, and if `packages/core` acquires I/O.

**Known test caveats.** The integration suite needs Docker and a live Postgres.
The conversation suite drives the deterministic policy rather than a live model —
deliberately, since what it asserts are properties of the harness (confirmation
gating, disambiguation, idempotent retry, the honesty guard) that hold whichever
model is plugged in. There is **no load test** and no end-to-end browser test;
both would be needed before production.
