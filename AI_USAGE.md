# Use of AI coding tools

> **Please review and edit before submitting.** The "What I reviewed" section
> below describes how this project was actually built. Adjust it so it matches
> your own account — it is your statement, not the tool's.

## How they were used

This project was built with **Claude Code** (Anthropic's CLI, Claude Opus 5) used
as a pair programmer throughout, working from the written brief. It produced the
bulk of the implementation: the schema and migrations, the CRM API, the domain
engine, the voice agent, the staff UI, the test suites and the documentation.

The workflow was iterative rather than one-shot:

1. **Design first.** `ARCHITECTURE.md` was written before any code and used as
   the reference for the rest of the work — stack rationale, ERD, the
   conversation state machine, and an explicit list of assumptions about the
   ambiguous parts of the brief.
2. **Vertical phases.** Scaffold → schema → API → CRM UI → voice agent →
   reliability hardening → tests and docs, each checked against a definition of
   done before moving on.
3. **Test-driven where it mattered.** The domain engine (availability, booking
   policy, DST, fuzzy time parsing) and the API were written alongside their
   tests. Several real bugs were caught this way before they reached a browser —
   the clearest being ISO timestamps compared as strings, where
   `…10:15:00.000Z` sorts before `…10:15:00Z` despite being the same instant.
4. **Manual testing drove most of the fixes.** The system was exercised by hand
   through the browser voice client, and the defects that surfaced there were the
   substantial ones. Each was reproduced with a script first, root-caused, fixed
   in the product code rather than papered over, and pinned with a regression
   test.

## What manual testing found

These were found by using the thing, not by reading it — and they are recorded in
`ARCHITECTURE.md §10` with the reasoning behind each fix:

| Found | Root cause |
|---|---|
| Agent asked "which appointment?", was told "the first one", and asked again forever | No handler for the answer; worse, the choice was never recorded on the session |
| Asked to change one appointment, both ended up cancelled | A staged cancellation survived the caller saying "actually no" — the documented invalidation had never been implemented |
| Booking gave vague, wandering replies | Service names matched as **substrings**, so "I'd like to book an appoint**men**t" silently resolved to "Men's Cut" |
| Asked for 9:30 am, booked 10:30 am | Spoken *local* times compared against *UTC* instants — exactly one hour out, and only during British Summer Time |
| Appointments appeared in the diary with no call record | Summaries were written only when a call ended, so a caller who never hung up was invisible |

Two of those (the staged-action invalidation and the abandoned-call record) were
behaviours the documentation **claimed** were already implemented. They were not.
Writing a guarantee down does not make it true, and it took manual testing to
show that.

## What I reviewed

*(Edit this to reflect your own involvement.)*

- **Ran and tested the system by hand**, through the browser voice client and the
  staff CRM, which is where the defects above were found.
- **Reviewed the architecture and the trade-offs** — in particular the decision
  to make double-booking prevention a database constraint rather than
  application logic, and to enforce the agent's safety properties structurally
  (an absent tool) rather than by prompt instruction.
- **Reviewed the schema and the SQL migration**, which is hand-written rather
  than ORM-generated precisely so it can be read.
- **Reviewed the test suite** for whether it asserts things that matter, and
  directed re-testing after each fix.
- Did **not** line-by-line review every file; the codebase is ~16k lines. The
  parts I read closely are the ones carrying the correctness claims: the
  migration, the scheduling service, the agent's tool layer and guards.

## An honest note on the limits

The parts I would want a second engineer to look hardest at:

- **The deterministic dialogue policy** (`apps/agent/src/llm/scripted.ts`). It is
  a keyword matcher standing in for a language model so the system runs without
  an API key. Most of the conversational bugs lived here, and it will keep having
  edges. It is not the production path.
- **The Twilio transport**, which is written to the interface but has never been
  run against a real phone call.
- **Load behaviour.** There is no load test. The concurrency guarantee is proven
  correct under an eight-way race, but not under sustained traffic.
