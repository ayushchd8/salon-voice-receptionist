# CRM API Reference

Base URL `http://localhost:4000` · all endpoints under `/v1`.
Interactive reference at [`/docs`](http://localhost:4000/docs); machine-readable spec at
[`docs/openapi.json`](./docs/openapi.json), generated from the same Zod schemas the handlers
validate with — the published spec cannot describe a contract the server does not enforce.

---

## Principles

**Tenancy is not a parameter.** `salon_id` is never accepted from a request body, path or
query. It is derived from the authenticated credential. A compromised or buggy client cannot
reach another salon's data by changing a value, and a forgotten `WHERE` clause cannot leak
across tenants — every repository function takes `salonId` from the principal, and the database
enforces it again with composite `(id, salon_id)` foreign keys.

**One error shape.** Every non-2xx response is:

```json
{
  "error": {
    "code": "SLOT_UNAVAILABLE",
    "message": "That time was just taken.",
    "details": { "requestedStart": "…", "alternatives": [ … ] },
    "requestId": "req_9f2c…"
  }
}
```

`code` is a closed enum shared by server and client, so clients branch on codes and never parse
prose. Changing a message is a copy edit, not a breaking change.

**Errors carry what you need to recover.** A refusal is never a dead end:
`SLOT_UNAVAILABLE` carries nearby bookable times; `CANCELLATION_WINDOW_PASSED` carries the fee,
the window and the hours remaining, plus `proceedWith: "acknowledgeFee"`;
`LEAD_TIME_TOO_SHORT` carries the earliest legal start.

## Authentication

Two credential classes, independently scoped and revocable.

```http
Authorization: Bearer sk_agent_…     # voice agent
Authorization: Bearer sk_staff_…     # staff
```

The staff UI instead exchanges its key once at `POST /v1/auth/session` for a signed, httpOnly
cookie, so a long-lived credential never sits in browser storage. The key row is re-read on
every request, so revoking a key ends live sessions immediately.

Keys are stored as SHA-256 hashes. `pnpm seed` prints the raw values once.

### Scopes

| Scope | Agent | Staff |
|---|:--:|:--:|
| `salon:read`, `services:read`, `hours:read`, `policies:read`, `staff:read` | ✓ | ✓ |
| `availability:read`, `appointments:read`, `appointments:write` | ✓ | ✓ |
| `customers:read`, `customers:write` | ✓ | ✓ |
| `calls:write` (open calls, save summaries) | ✓ | — |
| `customers:read:full` (surname, email, staff notes) | — | ✓ |
| `services:write`, `hours:write`, `policies:write`, `staff:write` | — | ✓ |
| `appointments:overbook` (deliberately double-book) | — | ✓ |
| `calls:read` (review screen) | — | ✓ |

The agent's lack of `customers:read:full` is load-bearing. Customer records are passed through a
projection before serialisation, so an agent-scoped caller receives `{id, firstName, phone,
isReturning}` and nothing else. The voice agent is structurally incapable of reading a
customer's staff notes aloud, because it never receives them.

## Correlation

| Header | Direction | Purpose |
|---|---|---|
| `X-Call-Id` | request | Set by the voice agent. Threads one call through agent turns → tool calls → API requests → database writes. |
| `X-Request-Id` | both | Honoured if a proxy set one; returned on every response, echoed in error bodies. |
| `Idempotency-Key` | request | Required on the three state-changing appointment endpoints. |
| `Idempotent-Replay` | response | `true` when a stored response was replayed instead of re-executing. |

---

## Idempotency

Required on `POST /v1/appointments`, `…/cancel` and `…/reschedule`.

The failure this prevents: the agent sends a booking, the response is lost to a timeout, the
agent retries, and the customer is booked twice.

| Situation | Response |
|---|---|
| New key | Request executes; `Idempotent-Replay: false` |
| Same key, same request, completed | Original response replayed; `Idempotent-Replay: true` |
| Same key, same request, still running | `409 IDEMPOTENCY_REQUEST_IN_PROGRESS` — back off and retry |
| Same key, **different** request | `422 IDEMPOTENCY_KEY_REUSED` |
| No key | `400 IDEMPOTENCY_KEY_REQUIRED` |

Two details that matter:

- **The reservation commits before the handler runs.** An uncommitted `INSERT` is invisible to
  other transactions, so reserving inside the business transaction would let a concurrent retry
  see no row and execute the booking a second time.
- **Only deterministic failures are stored.** Replaying a `422` is right — the same request will
  fail the same way. Replaying a `500` would be wrong: the client retries precisely because it
  wants a fresh attempt, so the key is released. A reservation left stale by a crashed request
  can be taken over after `IDEMPOTENCY_STALE_SECONDS`.

---

## Endpoints

### Salon, hours and policy

| Method | Path | Scope | Notes |
|---|---|---|---|
| GET | `/v1/salon` | `salon:read` | Profile and IANA timezone |
| GET | `/v1/business-hours` | `hours:read` | Always seven days, so a missing day reads as *closed*, not *unknown* |
| PUT | `/v1/business-hours` | `hours:write` | Whole-week replacement — a partial update of opening hours is nearly always a bug |
| POST | `/v1/closed-dates` | `hours:write` | Omit both times to close all day; provide both for special hours |
| DELETE | `/v1/closed-dates/:id` | `hours:write` | |
| GET | `/v1/booking-policy` | `policies:read` | Notice, fees, granularity |
| PATCH | `/v1/booking-policy` | `policies:write` | |

### Services and staff

| Method | Path | Scope | Notes |
|---|---|---|---|
| GET | `/v1/services` | `services:read` | `?active=true` by default — a caller asking "what do you offer" must not hear retired services |
| GET | `/v1/services/:id` | `services:read` | |
| POST/PATCH | `/v1/services` · `/v1/services/:id` | `services:write` | Services are retired, never deleted, so historic bookings still render |
| GET | `/v1/staff` | `staff:read` | Empty `serviceIds` = can do everything; empty `workingHours` = works salon hours |
| POST/PATCH | `/v1/staff` · `/v1/staff/:id` | `staff:write` | |

### Customers

| Method | Path | Scope | Notes |
|---|---|---|---|
| GET | `/v1/customers` | `customers:read` | Projected by scope |
| GET | `/v1/customers/search` | `customers:read` | By `phone`, `name` or `email`. A phone search also matches trailing digits — callers read out the last six far more often than a full international number |
| GET | `/v1/customers/:id` | `customers:read` | |
| POST | `/v1/customers` | `customers:write` | Phone normalised to E.164 before storage, so `07700 900123` and `+44 7700 900123` cannot become two records |
| PATCH | `/v1/customers/:id` | `customers:write` | Writing `notes` additionally requires `customers:read:full` |

### Availability

**`GET /v1/availability`** — `availability:read`

Accepts either an explicit `from`/`to` window **or** a natural-language `timeExpression`
("next friday afternoon", "a week from tuesday", "sometime after 3"), resolved server-side by
the same deterministic code the voice agent uses — an LLM should never be doing date arithmetic.

```http
GET /v1/availability?serviceId=…&timeExpression=next%20friday%20afternoon
```

```jsonc
{
  "timezone": "Europe/London",
  "service": { "id": "…", "name": "Cut & Blow Dry", "durationMinutes": 60 },
  "requestedWindow": { "from": "…", "to": "…", "interpretation": "Friday 11 September in the afternoon" },
  "slots": [
    { "start": "2026-09-11T11:00:00.000Z", "end": "…", "staffId": "…", "staffName": "Priya",
      "localDate": "2026-09-11", "localTime": "12:00", "label": "Friday at 12 pm" }
  ],
  "alternatives": [],
  "unavailableReason": null
}
```

Honours opening hours, holiday closures, per-staff shifts and competencies, existing bookings
*including their buffers*, minimum notice, and the maximum advance window. Slots carry
salon-local date, time and a speakable `label`, so no consumer re-derives a timezone.

When the requested window is empty, `alternatives` holds two or three nearby bookable times,
spread across different days. `interpretation` is meant to be read back to the caller for
confirmation.

**`GET /v1/resolve-time`** — `availability:read`. The resolver on its own, for grounding a
phrase before doing anything with it. Returns `422 UNPARSEABLE_TIME_EXPRESSION` rather than
guessing.

### Appointments

**`GET /v1/appointments`** — `appointments:read`. Filter by `customerId`, `phone`, `staffId`,
`serviceId`, `from`/`to`, `status` (repeatable), `upcomingOnly`. When more than one row comes
back for a caller, the agent must disambiguate rather than assume.

**`POST /v1/appointments`** — `appointments:write` · **`Idempotency-Key` required**

```jsonc
{
  "serviceId": "…",
  "start": "2026-09-11T11:00:00.000Z",
  "staffId": "…",                  // omit to let the engine assign the least-loaded qualified staff
  "source": "voice",
  "callId": "…",
  // exactly one of:
  "customerId": "…",
  "customer": { "firstName": "Nadia", "phone": "07700 900555" }
}
```

Passing `customer` creates the customer and the appointment together, so a crash between the
two cannot leave a customer with no booking.

The overlap check **is the write**. A Postgres `EXCLUDE USING gist` constraint serialises
concurrent attempts on the same slot, so of two simultaneous callers exactly one wins — there is
no check-then-write window. The loser receives `409 SLOT_UNAVAILABLE` with alternatives in
`details`, which is the moment the customer most needs one.

**`POST /v1/appointments/:id/cancel`** — `appointments:write` · **`Idempotency-Key` required**

```jsonc
{ "reason": "changed plans", "acknowledgeFee": false }
```

A cancellation inside the notice window is **not refused**. It returns:

```jsonc
{ "error": { "code": "CANCELLATION_WINDOW_PASSED",
  "message": "That's inside our 24-hour cancellation window, so a GBP 15.00 late cancellation fee applies.",
  "details": { "windowHours": 24, "hoursUntilAppointment": 6.5, "feeApplies": true,
               "fee": "15.00", "currency": "GBP", "proceedWith": "acknowledgeFee" } } }
```

The caller can then be told the fee and asked. Retrying with `acknowledgeFee: true` proceeds and
records the fee. Silently refusing would leave a customer unable to cancel at all; silently
charging would be worse.

**`POST /v1/appointments/:id/reschedule`** — `appointments:write` · **`Idempotency-Key` required**

Atomic. Releasing the old slot and taking the new one happen in one transaction, so a conflict
on the new time rolls the release back and the original appointment stands. There is no state in
which the customer has lost their slot and not gained another. Returns the **new** appointment;
the old one remains readable with status `rescheduled` and a `rescheduledToId` pointing forward.

Subject to the same notice policy as cancelling — otherwise "move it to next year" would be a
free cancellation.

**`POST /v1/appointments/:id/status`** — staff only. Mark `completed` or `no_show`.

### Calls and outcomes

| Method | Path | Scope | Notes |
|---|---|---|---|
| POST | `/v1/calls` | `calls:write` | Opens a call log. The returned id becomes `X-Call-Id` for the rest of the call |
| POST | `/v1/calls/:id/end` | `calls:write` | Closes it and stores the transcript |
| POST | `/v1/call-summaries` | `calls:write` | Upserts on `callId` — written for **every** call in a `finally` block |
| GET | `/v1/call-summaries` | `calls:read` | Filter by `escalated`, `actionResult`, `appointmentAction`, `intent`, `customerId`, date range, free text |
| GET | `/v1/call-summaries/:callId` | `calls:read` | Includes transcript and the agent's event trail |

A summary records the detected intents, services discussed, the action attempted and its **real**
result, the confirmed appointment, a natural-language summary, the structured event list (tool
calls with latency and outcome, confirmations, errors, guard trips) and any escalation or
callback details. Two database CHECK constraints hold it honest: a `failed` result must carry a
`failureReason`, and an escalation must carry a reason.

### Health

`GET /health` — liveness. `GET /ready` — readiness, including the database; returns 503 when the
database is unreachable, so a failing dependency drains traffic instead of triggering a restart
loop.

---

## Error codes

| Code | Status | Meaning |
|---|---|---|
| `VALIDATION_FAILED` | 400 | Malformed request. `details.fields[]` gives path and reason per field |
| `IDEMPOTENCY_KEY_REQUIRED` | 400 | Missing `Idempotency-Key` on a state-changing endpoint |
| `UNAUTHENTICATED` | 401 | Missing, unknown or revoked credential |
| `FORBIDDEN_SCOPE` | 403 | Valid credential, insufficient scope. `details.missing[]` lists what is needed |
| `CUSTOMER_NOT_FOUND` · `SERVICE_NOT_FOUND` · `STAFF_NOT_FOUND` · `APPOINTMENT_NOT_FOUND` · `CALL_NOT_FOUND` | 404 | Also returned when the record belongs to another salon |
| `DUPLICATE_CUSTOMER_PHONE` | 409 | That number is already on file |
| `SLOT_UNAVAILABLE` | 409 | Taken. `details.alternatives[]` carries nearby times |
| `NO_STAFF_AVAILABLE` | 409 | Nobody who performs that service works then |
| `IDEMPOTENCY_REQUEST_IN_PROGRESS` | 409 | Identical request in flight; retry shortly with the same key |
| `OUTSIDE_BUSINESS_HOURS` | 422 | The full service duration must fit inside opening hours |
| `SALON_CLOSED_ON_DATE` | 422 | Closed that day. `details.reason` when there is one |
| `STAFF_NOT_WORKING` · `STAFF_CANNOT_PERFORM_SERVICE` | 422 | |
| `SERVICE_INACTIVE` | 422 | Retired service |
| `BOOKING_IN_PAST` · `LEAD_TIME_TOO_SHORT` · `TOO_FAR_IN_ADVANCE` | 422 | Policy. Carry `earliestStart` / `latestStart` |
| `CANCELLATION_WINDOW_PASSED` | 422 | Retry with `acknowledgeFee: true` |
| `APPOINTMENT_NOT_MODIFIABLE` | 422 | Already cancelled, completed, or started |
| `MAX_ACTIVE_APPOINTMENTS_REACHED` | 422 | Per-customer cap |
| `OVERBOOKING_NOT_ALLOWED` | 422 | Salon policy forbids it |
| `IDEMPOTENCY_KEY_REUSED` | 422 | Key already used for a different request |
| `UNPARSEABLE_TIME_EXPRESSION` | 422 | Ask the caller to be specific rather than guessing |
| `RATE_LIMITED` | 429 | Per-credential |
| `INTERNAL_ERROR` | 500 | |
| `SERVICE_UNAVAILABLE` | 503 | |

Clients may retry `INTERNAL_ERROR`, `SERVICE_UNAVAILABLE`, `RATE_LIMITED` and
`IDEMPOTENCY_REQUEST_IN_PROGRESS` — reusing the same idempotency key. Everything else is a
definitive answer and retrying only wastes call time. The two sets are exported from
`@salon/contracts` as `RETRYABLE_ERROR_CODES` and `RECOVERABLE_SCHEDULING_CODES`.

## Rate limiting

Registered per authenticated principal rather than per IP — every call from the voice agent
shares one source address. Permissive in development (`RATE_LIMIT_MAX`, `RATE_LIMIT_WINDOW`);
tightening it is a config change, not a code change.
