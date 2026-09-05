# Example calls

Six calls through the running system, covering the behaviours that matter most.

**These are real transcripts.** Every one was captured by driving the live agent
over its WebSocket against the real CRM API and PostgreSQL, and pasted here
verbatim — including the tool calls listed on the right, which are the same trail
written to the call record the salon reviews afterwards. Nothing below was
written by hand: `node scripts/example-calls.mjs` prints this file's content.

The dialogue policy in these transcripts is the deterministic no-API-key
fallback, so the wording is plainer than a language model's. What is being shown
is the *machinery* — the confirmation gate, the disambiguation, the honesty
guard — which is identical either way. Set `ANTHROPIC_API_KEY` for natural
phrasing over exactly the same tools.

---
stopping the database…
  restarting the database…

### 1 · A successful booking

A new caller books from scratch. Nothing is written until the details are read back and agreed.

| | | Tools called |
|---|---|---|
| **Agent** | Good day, Luxe Hair Studio — is that Danny? How can I help? |  |
| **Caller** | I would like to book an appointment |  |
| **Agent** | We do Full Head Colour at GBP 110.00, Highlights at GBP 145.00, Root Touch-Up at GBP 68.00, Colour Consultation at GBP 0.00, and a few others. What were you after? | `list_services` |
| **Caller** | a cut and blow dry |  |
| **Agent** | Cut & Blow Dry, lovely — when were you thinking? | `select_service` |
| **Caller** | next Tuesday morning |  |
| **Agent** | I've got Tuesday at 9 am, or Tuesday at 9:15 am, or Tuesday at 9:30 am. Which suits you? | `check_availability` |
| **Caller** | the second one |  |
| **Agent** | Cut & Blow Dry, Tuesday at 9:15 am with Sam Okonkwo, for Danny. That's GBP 55.00. Shall I book that? | `propose_booking` |
| **Caller** | yes please |  |
| **Agent** | Lovely — that's booked in for you, Tuesday at 9:15 am. Anything else I can help with? | `commit_pending_action` |

### 2 · An unavailable requested time

The salon is closed on Sundays. The agent says why, and offers real alternatives rather than a dead end.

| | | Tools called |
|---|---|---|
| **Agent** | Good day, Luxe Hair Studio — is that Danny? How can I help? |  |
| **Caller** | can I book a blow dry on Sunday morning? |  |
| **Agent** | I'm afraid we're closed that day. I could do Monday at 9 am, or Tuesday at 9 am, or Wednesday at 9 am. Would any of those work? | `check_availability` |
| **Caller** | Monday at 9 then |  |
| **Agent** | I've got Monday at 9 am, or Monday at 9:15 am, or Monday at 9:30 am. Which suits you? | `check_availability` |
| **Caller** | yes please |  |
| **Agent** | Blow Dry, Monday at 9 am with Priya Raman, for Danny. That's GBP 38.00. Shall I book that? | `propose_booking` |

### 3 · Finding and cancelling an appointment

Eleanor has two appointments, so the agent must ask which — it never guesses.

| | | Tools called |
|---|---|---|
| **Agent** | Good day, Luxe Hair Studio — is that Eleanor? How can I help? |  |
| **Caller** | I need to cancel my appointment |  |
| **Agent** | You've got two booked — your Cut & Blow Dry Monday at 10:30 am, and your Root Touch-Up Monday 14 September at 12:30 pm. Which one did you mean? | `find_appointments` |
| **Caller** | the first one |  |
| **Agent** | Cancelling your Cut & Blow Dry Monday at 10:30 am with Priya Raman. No charge. Shall I go ahead? | `propose_cancellation` |
| **Caller** | yes please |  |
| **Agent** | That's cancelled for you. Anything else I can help with? | `commit_pending_action` |

**Eleanor's diary afterwards**

- completed · Full Head Colour · Saturday 8 August at 11 am
- cancelled · Cut & Blow Dry · Monday at 10:30 am
- booked · Root Touch-Up · Monday 14 September at 12:30 pm


### 4 · Rescheduling an appointment

The old slot is released and the new one taken in a single transaction.

| | | Tools called |
|---|---|---|
| **Agent** | Good day, Luxe Hair Studio — is that Eleanor? How can I help? |  |
| **Caller** | I want to move my appointment |  |
| **Agent** | That's your Root Touch-Up Monday 14 September at 12:30 pm. When would you like to move it to? | `find_appointments` |
| **Caller** | next Thursday afternoon |  |
| **Agent** | I've got Thursday at 12 pm, or Thursday at 12:15 pm, or Thursday at 12:30 pm. Which suits you? | `check_availability` |
| **Caller** | the first one |  |
| **Agent** | Moving your Root Touch-Up from Monday 14 September at 12:30 pm to Thursday at 12 pm. Shall I move it? | `propose_reschedule` |
| **Caller** | yes |  |
| **Agent** | Lovely — I've moved that to Thursday at 12 pm. Anything else I can help with? | `commit_pending_action` |

**Eleanor's diary afterwards**

- completed · Full Head Colour · Saturday 8 August at 11 am
- cancelled · Cut & Blow Dry · Monday at 10:30 am
- booked · Root Touch-Up · Thursday at 12 pm
- rescheduled · Root Touch-Up · Monday 14 September at 12:30 pm


### 5 · An API failure

The database is stopped between the agent reading the booking back and the caller agreeing to it. The outcome is taken from the HTTP response, so the agent reports what actually happened rather than what it was about to say.

| | | Tools called |
|---|---|---|
| **Agent** | Good day, Luxe Hair Studio — is that Danny? How can I help? |  |
| **Caller** | I want to book a full head colour |  |
| **Agent** | Full Head Colour, lovely — when were you thinking? | `select_service` |
| **Caller** | next Thursday afternoon |  |
| **Agent** | I've got Thursday at 1 pm, or Thursday at 1:15 pm, or Thursday at 1:30 pm. Which suits you? | `check_availability` |
| **Caller** | the first one |  |
| **Agent** | Full Head Colour, Thursday at 1 pm with Alex Whitfield, for Danny. That's GBP 110.00. Shall I book that? | `propose_booking` |
| *(the database goes down here)* |  |  |
| **Caller** | yes please |  |
| **Agent** | I'm sorry — that didn't go through, so nothing has changed. Shall I take your number and have someone call you back? | `commit_pending_action` |

Guard tripped on that turn: **false**  ·  state: **RESULT_FAILED**


### 6 · A customer correcting previously provided information

The caller changes the service mid-flow, then changes the time after hearing it read back.

| | | Tools called |
|---|---|---|
| **Agent** | Good day, Luxe Hair Studio — is that Marcus? How can I help? |  |
| **Caller** | I want to book a cut and blow dry |  |
| **Agent** | Cut & Blow Dry, lovely — when were you thinking? | `select_service` |
| **Caller** | actually make that a full head colour instead |  |
| **Agent** | Full Head Colour, lovely — when were you thinking? | `select_service` |
| **Caller** | next Wednesday afternoon |  |
| **Agent** | I've got Wednesday at 12 pm, or Wednesday at 12:15 pm, or Wednesday at 12:30 pm. Which suits you? | `check_availability` |
| **Caller** | the first one |  |
| **Agent** | Full Head Colour, Wednesday at 12 pm with Alex Whitfield, for Marcus. That's GBP 110.00. Shall I book that? | `propose_booking` |
| **Caller** | no wait, the second one |  |
| **Agent** | Full Head Colour, Wednesday at 12:15 pm with Alex Whitfield, for Marcus. That's GBP 110.00. Shall I book that? | `propose_booking` |
| **Caller** | yes please |  |
| **Agent** | Lovely — that's booked in for you, Wednesday at 12:15 pm. Anything else I can help with? | `commit_pending_action` |

---

## What each one is demonstrating

| Call | The guarantee behind it |
|---|---|
| **1 · Successful booking** | `commit_pending_action` does not exist as a callable tool until a proposal has been staged *and* the caller has had a turn to answer it. The agent physically cannot book without reading the details back first. |
| **2 · Unavailable time** | The reason comes from the API (`unavailableReason`), so a closed day is described as closed rather than "fully booked" — telling someone you are full when you are shut is wrong information they will plan around. Alternatives are real bookable slots, spread across different days. |
| **3 · Find and cancel** | Two matches set `requiresDisambiguation`, and `propose_cancellation` refuses at the tool layer unless given an id drawn from the candidates actually looked up for this caller. Guessing would cancel the wrong appointment. |
| **4 · Reschedule** | Releasing the old slot and taking the new one happen in one database transaction. A conflict on the new time rolls the release back, so there is no state in which the customer has lost their slot and not gained another. |
| **5 · API failure** | The outcome is recorded by the tool layer from the HTTP status, never inferred from model text. A second guard inspects every utterance and suppresses success language that contradicts it. Had the write *timed out* rather than failed outright, the outcome would be `unknown` and the agent would say it could not confirm — a timed-out write may well have landed. |
| **6 · Correction** | A staged action survives only an unqualified yes; any correction discards it and the agent must propose again with a fresh idempotency key. What gets committed is always what was read aloud. |

## Reproducing these

```bash
pnpm db:up && pnpm migrate && pnpm seed
pnpm dev                        # API :4000 · agent :4100 · CRM :5173
node scripts/example-calls.mjs  # prints exactly what is above
```

Scenario 5 stops and starts the `db` container, so expect a few seconds of
database downtime while it runs. The script waits for it to come back.

The same behaviours are pinned by the automated suite: `pnpm test:agent` runs
108 conversation tests over real HTTP against a CRM that can be told to time
out, fail, or lose a slot mid-conversation — see
[`apps/agent/src/agent/conversation.test.ts`](./apps/agent/src/agent/conversation.test.ts).
