/**
 * The conversation loop.
 *
 * One caller turn in, one agent utterance out, with any number of tool calls in
 * between. The loop itself is deliberately small — the interesting decisions
 * live in the pieces it composes:
 *
 *   session state  ->  which tools exist this turn   (tools/definitions.ts)
 *   tool layer     ->  what actually happened        (tools/executor.ts)
 *   guards         ->  what may be said about it     (agent/guards.ts)
 *
 * Because the tool list is recomputed from `session.state` on every iteration,
 * a tool that appears mid-turn (commit_pending_action, after a proposal is
 * staged) is available immediately, and one that should not exist yet simply
 * is not offered.
 */
import type { CrmClient } from '../crm/client.js';
import type { LlmAdapter, LlmMessage } from '../llm/types.js';
import { ToolExecutor } from '../tools/executor.js';
import { toolsForState } from '../tools/definitions.js';
import { buildSystemPrompt } from './prompt.js';
import { applyGuards } from './guards.js';
import { classifyConfirmation } from './confirmation.js';
import { addIntent, addTurn, recordEvent, transition, type CallSession } from '../session/types.js';
import { detectIntents, statedIntent } from './intents.js';
import { logger } from '../logger.js';

/** A hard stop, so a confused model cannot loop tools forever on a live call. */
const MAX_TOOL_ROUNDS = 6;

const fingerprint = (name: string, input: Record<string, unknown>) => `${name}:${JSON.stringify(input)}`;

export interface TurnResult {
  /** What to say to the caller. */
  utterance: string;
  /** Tool names called this turn, for the debug panel. */
  toolsUsed: string[];
  guardTripped: boolean;
  state: CallSession['state'];
  ended: boolean;
}

export class Orchestrator {
  private readonly executor: ToolExecutor;
  /** The model-facing history. The session object holds the durable facts. */
  private readonly history: LlmMessage[] = [];

  constructor(
    private readonly session: CallSession,
    private readonly llm: LlmAdapter,
    crm: CrmClient,
  ) {
    this.executor = new ToolExecutor(crm, session);
  }

  async handleUserTurn(text: string): Promise<TurnResult> {
    this.session.turnCount += 1;
    addTurn(this.session, 'caller', text);
    this.history.push({ role: 'user', content: text });

    // Tag the caller's intent from their own words, independently of anything
    // the model does. Tools record intent when they are called, but a call that
    // ends before any tool runs — the caller hangs up, the model stalls, the
    // request is out of scope — would otherwise be filed as "no clear request".
    // Those are exactly the calls a salon manager wants to find later.
    for (const intent of detectIntents(text)) addIntent(this.session, intent);

    // What they are trying to do *right now*, from their own words. Set here
    // rather than when a proposal is staged, because the decisions that depend
    // on it — chiefly what "the first one" refers to — happen well before that.
    const stated = statedIntent(text);
    if (stated === 'cancel' || stated === 'reschedule') {
      this.session.activeIntent = stated;
    } else if (stated === 'book' && this.session.activeIntent === null) {
      // A booking word during a reschedule ("when can you fit me in?") is not
      // a change of plan.
      this.session.activeIntent = 'book';
    }

    // A staged action survives only an unqualified yes.
    //
    // The caller who says "actually no, I want to move it instead" has changed
    // the plan; leaving the cancellation staged means a later "yes" — to some
    // entirely different question — commits it, and the wrong appointment is
    // cancelled. So anything that is not a clear acceptance throws the staging
    // away and the agent must propose again.
    //
    // Enforced here rather than asked for in the prompt, because the cost of
    // the model getting it wrong is a customer losing an appointment they
    // explicitly said they wanted to keep.
    this.invalidateStaleConfirmation(text);

    if (this.session.state === 'GREETING') {
      transition(this.session, 'ROUTING', 'caller spoke');
    }

    const toolsUsed: string[] = [];
    let utterance = '';
    let understood = true;
    // Guards against a model that answers every tool result by asking for the
    // same tool again — a live caller would otherwise hear nothing at all
    // while the loop burned through its rounds.
    const seenCalls = new Set<string>();

    for (let round = 0; round < MAX_TOOL_ROUNDS; round += 1) {
      const request = {
        // Rendered fresh each round, so the model sees the state its own tool
        // calls just produced.
        system: buildSystemPrompt(this.session),
        messages: this.history,
        // A proposal staged during *this* turn cannot be committed in the same
        // turn — the caller has not heard the restatement yet, let alone
        // agreed to it.
        tools: toolsForState(
          this.session.state,
          this.session.pendingConfirmation !== null &&
            this.session.pendingConfirmation.stagedOnTurn < this.session.turnCount,
        ),
      };

      let turn;
      try {
        turn = await this.llm.complete(request);
      } catch (err) {
        logger.error({ callId: this.session.callId, err }, 'LLM turn failed');
        recordEvent(this.session, 'api_error', { component: 'llm', message: String(err) }, { outcome: 'error' });
        // Degrade rather than drop the call.
        utterance = "Sorry — could you say that again for me?";
        break;
      }

      this.history.push({ role: 'assistant', text: turn.text, toolCalls: turn.toolCalls });

      if (turn.toolCalls.length === 0) {
        utterance = turn.text;
        understood = turn.understood !== false;
        break;
      }

      const repeated = turn.toolCalls.filter((c) => seenCalls.has(fingerprint(c.name, c.input)));
      if (repeated.length === turn.toolCalls.length) {
        logger.warn(
          { callId: this.session.callId, tools: repeated.map((c) => c.name) },
          'model repeated an identical tool call — ending the turn',
        );
        recordEvent(this.session, 'guard_tripped', {
          guard: 'repeated_tool_call',
          tools: repeated.map((c) => c.name),
        });
        if (!utterance) utterance = turn.text;
        break;
      }
      for (const c of turn.toolCalls) seenCalls.add(fingerprint(c.name, c.input));

      // Parallel tool calls are executed together and their results returned in
      // a single message — splitting them would train the model out of making
      // parallel calls at all.
      // The state machine decides which tools exist this turn. Offering a
      // reduced list is only a guarantee if calling something outside it is
      // actually refused — otherwise a model that ignores the list, or a
      // regression in how the list is built, walks straight past the gate.
      const allowed = new Set(request.tools.map((t) => t.name));

      const results = await Promise.all(
        turn.toolCalls.map(async (call) => {
          toolsUsed.push(call.name);

          if (!allowed.has(call.name)) {
            logger.warn(
              { callId: this.session.callId, tool: call.name, state: this.session.state },
              'refused a tool that is not available in this state',
            );
            recordEvent(this.session, 'guard_tripped', {
              guard: 'tool_not_available',
              tool: call.name,
              state: this.session.state,
            });
            return {
              id: call.id,
              isError: true,
              content: {
                error: 'TOOL_NOT_AVAILABLE',
                message: `${call.name} cannot be used right now.`,
                guidance:
                  call.name === 'commit_pending_action'
                    ? 'Nothing is waiting to be confirmed. Propose the action, read it back, and get a clear yes first.'
                    : 'Use one of the tools you were given for this turn.',
              },
            };
          }

          const result = await this.executor.execute(call.name, call.input);
          return { id: call.id, content: result.content, isError: result.isError ?? false };
        }),
      );
      this.history.push({ role: 'tool_results', results });

      // A tool may have said something worth speaking immediately (a staged
      // restatement, a farewell) even before the model's next turn.
      if (turn.text) utterance = turn.text;

      if (this.session.ended) {
        const farewell = results
          .map((r) => (r.content as { farewell?: string }).farewell)
          .find(Boolean);
        if (farewell) utterance = farewell;
        break;
      }
    }

    if (!utterance) {
      utterance = 'Sorry, could you say that once more?';
    }

    // A conversation that keeps landing in the same state having called the
    // same tools is going in circles, however fluent each individual reply
    // sounds. The caller experiences this as being asked the same question
    // over and over — so offer them a person instead of continuing.
    const stalled = this.detectStall(toolsUsed, understood);
    if (stalled) {
      utterance =
        "I'm sorry — I don't seem to be getting this right for you. Let me take your name and " +
        'number and have someone from the salon call you back.';
    }

    // Nothing reaches the caller without passing the guards.
    const guarded = applyGuards(this.session, utterance);
    addTurn(this.session, 'agent', guarded.text);

    this.maybeEscalate();

    return {
      utterance: guarded.text,
      toolsUsed,
      guardTripped: guarded.tripped,
      state: this.session.state,
      ended: this.session.ended,
    };
  }

  /** Discard a staged action the caller has not just agreed to. */
  private invalidateStaleConfirmation(utterance: string): void {
    const pending = this.session.pendingConfirmation;
    if (!pending) return;

    const verdict = classifyConfirmation(utterance);
    if (verdict === 'affirmative') return;

    logger.info(
      { callId: this.session.callId, action: pending.action, verdict },
      'caller did not confirm — discarding the staged action',
    );
    recordEvent(this.session, 'confirmation_received', {
      action: pending.action,
      affirmative: false,
      verdict,
      discarded: true,
    });

    // A new idempotency key is minted when the action is proposed again, so the
    // re-proposed action is a genuinely new request rather than a replay of the
    // one the caller rejected.
    this.session.pendingConfirmation = null;
    transition(this.session, 'COLLECTING', `caller did not confirm the ${pending.action}`);
  }

  /**
   * Has the conversation stopped moving?
   *
   * Compares each turn's state and tool calls with the previous one. Three
   * identical turns in a row means the caller is being asked the same thing
   * repeatedly and nothing is changing — the failure mode a fluent agent hides
   * best, because every individual reply reads as reasonable.
   */
  private detectStall(toolsUsed: string[], understood: boolean): boolean {
    // A turn that called a tool did real work — answered a question, checked
    // the diary — even if no slot changed. Counting those as stalls escalated
    // callers who were simply asking a few things in a row.
    //
    // What actually signals a stuck conversation is the agent repeatedly not
    // understanding, so that is what is counted. The no-progress fingerprint
    // remains as a backstop for a turn that neither understood nor acted.
    const didWork = toolsUsed.length > 0;
    if (didWork || understood) {
      this.session.stalledTurns = 0;
      this.session.lastTurnSignature = null;
      return false;
    }

    // Fingerprinted on *progress*, not on the turn's shape.
    //
    // An earlier version compared consecutive turns and missed the loop that
    // actually happened in practice: the agent alternated between reading the
    // service menu and giving a generic reply, so no two consecutive turns
    // looked alike while the conversation went precisely nowhere. What matters
    // is whether anything moved — who we are talking about, what service, which
    // appointment, whether something is staged, whether a write landed.
    const session = this.session;
    const signature = [
      session.state === 'FAQ' ? 'INFO' : session.state,
      session.customer?.id ?? '-',
      session.slots.serviceId ?? '-',
      session.slots.appointmentId ?? '-',
      session.slots.chosenSlot?.start ?? '-',
      session.candidates.length,
      session.pendingConfirmation?.idempotencyKey ?? '-',
      session.lastWriteOutcome?.at ?? '-',
    ].join('|');

    session.lastTurnSignature = signature;
    session.stalledTurns += 1;

    // Three misunderstandings in a row. Offer them a person.
    if (session.stalledTurns < 3) return false;

    // Only escalate once; after that the escalation flow takes over.
    if (this.session.escalation) return false;

    logger.warn(
      { callId: this.session.callId, signature, misunderstoodTurns: this.session.stalledTurns },
      'the caller has not been understood several times running — escalating',
    );
    recordEvent(this.session, 'guard_tripped', {
      guard: 'conversation_stalled',
      signature,
      repeatedTurns: this.session.stalledTurns + 1,
    });
    this.session.escalation = {
      reason: 'The conversation stopped progressing — the caller was asked the same thing repeatedly',
    };
    transition(this.session, 'ESCALATION', 'conversation stalled');
    recordEvent(this.session, 'escalated', { reason: 'conversation_stalled' });
    return true;
  }

  /**
   * Offer a human after repeated failure.
   *
   * Left to itself a model will happily try the same failing thing a fourth
   * time. A caller will not.
   */
  private maybeEscalate(): void {
    if (this.session.escalation) return;
    if (this.session.consecutiveFailures < 3) return;

    this.session.escalation = { reason: 'Repeated failures completing the caller\'s request' };
    transition(this.session, 'ESCALATION', 'too many consecutive failures');
    recordEvent(this.session, 'escalated', { reason: 'consecutive_failures', count: this.session.consecutiveFailures });
  }

  /** Exposed for the debug panel and the conversation tests. */
  get sessionState(): CallSession {
    return this.session;
  }
}
