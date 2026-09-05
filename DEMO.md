# Demo guide

A five-minute walkthrough that exercises everything worth seeing. No API keys
needed — speech recognition and synthesis run in the browser.

There is no recorded video in this repository; this is the live-demo script.
[`EXAMPLES.md`](./EXAMPLES.md) has the same conversations as real captured
transcripts if you would rather read than run.

---

## Setup (about two minutes)

```bash
pnpm install
cp .env.example .env

pnpm db:up      # PostgreSQL 16 in Docker, waits until it accepts connections
pnpm migrate
pnpm seed       # prints the API keys — copy the sk_staff_… one

pnpm dev        # API :4000 · voice agent :4100 · staff CRM :5173
```

Open two tabs:

| | |
|---|---|
| **The phone line** | <http://localhost:4100> |
| **The salon's CRM** | <http://localhost:5173> — sign in with the `sk_staff_…` key |

Use **Chrome or Edge** for real speech. Any other browser falls back to a text
box; everything behind it is identical.

> The demo caller ID is Eleanor's number, so she is recognised by name. To be
> somebody else, change `callerPhone` in `apps/agent/public/app.js:190` —
> `+447700900002` is Marcus, `+447700900006` is Danny, and `null` makes you an
> unknown caller the agent has to take details from.

---

## The walkthrough

Click **Start call**, then hold the mic button and speak. The panel on the right
shows every tool call, state transition and guard trip as it happens — the same
trail written to the call record.

### 1. It answers questions from live data (30s)

> *"What time do you open on Saturday?"*
> *"Are you open on Sundays?"*
> *"How much is a full head colour?"*

Nothing is scripted. Each answer is a tool call into the CRM — change a price or
an opening time in the CRM tab and ask again, and the answer changes.

### 2. It books, but only after reading it back (60s)

> *"I'd like to book a cut and blow dry next Friday afternoon"*
> *"the second one"*
> *"yes please"*

Watch the state go `AVAILABILITY → CONFIRMING → RESULT_SUCCESS`. Note that the
booking tool only appears in the trail *after* you agreed — before that it does
not exist as a callable tool at all.

**Then check the CRM tab.** The appointment is in the diary, and the call is in
**Call review** — tagged *"on the line now"*, because you have not hung up yet.

### 3. It offers alternatives instead of a dead end (30s)

> *"Can I book a blow dry on Sunday morning?"*

It says the salon is **closed** — not "fully booked" — and offers three real
bookable times across different days.

### 4. It never guesses which appointment you mean (45s)

Eleanor has two on file.

> *"I need to cancel my appointment"*

It reads both back and asks which. Answer any way you like — *"the first one"*,
*"the colour one"*, *"the Monday one"* — then confirm. Only that one is
cancelled.

### 5. It lets you change your mind (30s)

> *"I want to cancel my appointment"* → pick one → **then say** *"actually no,
> leave it"* → then *"yes"*

Nothing is cancelled. The staged action was discarded the moment you corrected
it, so a later "yes" cannot commit something you backed out of.

### 6. It tells the truth when the system fails (45s)

With a booking read back and waiting for your confirmation, in another terminal:

```bash
docker compose stop db
```

Now say *"yes please"*.

It says it did not go through and offers a callback. It does **not** say you are
booked. Bring it back with:

```bash
docker compose start db
```

### 7. It hands over when it should (30s)

> *"I want a refund, the colour you had done last month was ruined"*
> *"my name is Tom and my number is 07700 900004"*

Out of scope for a receptionist, so it takes a callback. In the CRM's **Call
review**, filter by **Escalated only** — the call is there with the reason and
the callback details.

---

## Testing the second salon

The seed creates **two** salons to prove that onboarding is a data change, not a
code change. Bella Beauty Bar is in New York, prices in dollars, is **closed
Mondays and open Sundays** (the inverse of Luxe), needs a full day's notice, has
a 48-hour cancellation window and books on 30-minute boundaries.

Everything is scoped by the credential, so switching salon is a matter of which
key you present.

**The CRM** — sign out and sign back in with Bella's staff key:

```
sk_staff_bella_2222222222222222222222222222
```

Same screens, different salon. Nothing else changes.

**The phone line** — each salon needs its own agent process, exactly as each
would have its own phone number in production. Leave Luxe running and start a
second line on another port:

```bash
AGENT_PORT=4101 CRM_API_KEY=sk_agent_bella_1111111111111111111111111111 \
  pnpm --filter @salon/agent dev
```

Then open <http://localhost:4101>. Bella's customers are Dana
(`+12125550111`) and Luis (`+12125550112`), so change `callerPhone` in
`apps/agent/public/app.js:190` to be recognised — otherwise you are an unknown
caller and the agent will ask for your details, which is also worth seeing.

Worth trying, because the answers come from Bella's own configuration:

> *"What are your opening hours?"* — Tuesday to Wednesday 10:00–19:00, Thursday to
> Friday 10:00–21:00, Saturday 09:00–18:00, Sunday 11:00–17:00, closed Mondays
> *"Are you open on Mondays?"* — closed, unlike Luxe
> *"How much is a balayage?"* — **USD** 285.00, a service Luxe does not offer
> *"Can I book one next Wednesday afternoon?"* — slots land on **30-minute**
> boundaries rather than Luxe's 15

**Tenancy is enforced, not assumed.** Bella's key cannot see a Luxe customer or
appointment — `salon_id` comes from the credential, never from a request, and
composite `(id, salon_id)` foreign keys make a cross-tenant reference impossible
at the storage layer. The isolation tests in
`apps/api/src/routes/lifecycle.test.ts` try exactly that and expect a 404.

---

## What to look at afterwards

| Where | What it shows |
|---|---|
| **CRM → Call review → Open** | The full transcript and the agent's event trail: every tool call with latency and outcome, confirmations, errors, guard trips. |
| **CRM → Appointments** | Book, move and cancel as a staff member. The same API the agent uses. |
| **CRM → Hours, Policy** | Change opening hours or the notice period, then ask the agent about them. |
| **<http://localhost:4000/docs>** | The API reference, generated from the same schemas the server validates with. |

## If something looks wrong

| Symptom | Cause |
|---|---|
| "Could not reach the CRM API" | The API is not running, or `CRM_API_KEY` does not match a seeded key. `pnpm seed` reprints them. |
| The mic button is disabled | No Web Speech API in this browser. Use the text box, or Chrome/Edge. |
| Nothing is available at any time | The seed may not have run, or the date is outside the salon's 90-day booking window. `pnpm db:reset`. |
| The agent's wording is plain | No `ANTHROPIC_API_KEY` set, so the deterministic fallback policy is driving. Set the key for natural dialogue over the same tools. |
