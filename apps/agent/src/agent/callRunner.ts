/**
 * Call lifecycle: open a call record, load the salon's configuration, run the
 * conversation, and — always — persist a structured summary.
 *
 * The summary is written in a `finally` block. A call that crashed, was hung up
 * on, or failed halfway through a booking is exactly the call a salon manager
 * needs to see, so those must not be the ones that go unrecorded.
 */
import type { CallSession, SalonContext } from '../session/types.js';
import { createSession, recordEvent } from '../session/types.js';
import { Orchestrator } from './orchestrator.js';
import { crm as defaultCrm, type CrmClient } from '../crm/client.js';
import { createLlmAdapter } from '../llm/index.js';
import type { LlmAdapter } from '../llm/types.js';
import { greeting } from './prompt.js';
import { callLogger } from '../logger.js';
import type { CallIntent } from '@salon/contracts';

export interface StartCallOptions {
  callerPhone: string | null;
  transport: CallSession['transport'];
  crm?: CrmClient;
  llm?: LlmAdapter;
}

export class CallRunner {
  readonly session: CallSession;
  readonly orchestrator: Orchestrator;
  private readonly crm: CrmClient;
  private readonly log;
  private summarised = false;

  private constructor(session: CallSession, crm: CrmClient, llm: LlmAdapter) {
    this.session = session;
    this.crm = crm;
    this.orchestrator = new Orchestrator(session, llm, crm);
    this.log = callLogger(session.callId, session.callerPhone);
  }

  static async start(options: StartCallOptions): Promise<CallRunner> {
    const crm = options.crm ?? defaultCrm;
    const llm = options.llm ?? createLlmAdapter();

    // Open the call record first: if anything after this fails, the call still
    // exists to attach a summary to.
    const call = await crm.startCall({
      callerPhone: options.callerPhone,
      transport: options.transport,
    });

    // Salon configuration, fetched once and reused for every turn.
    const [salon, services, staff, hours, policy] = await Promise.all([
      crm.getSalon({ callId: call.id }),
      crm.listServices({ callId: call.id }),
      crm.listStaff({ callId: call.id }),
      crm.getBusinessHours({ callId: call.id }),
      crm.getPolicy({ callId: call.id }),
    ]);
    const context: SalonContext = { salon, services, staff, hours, policy };

    const session = createSession({
      callId: call.id,
      transport: options.transport,
      callerPhone: options.callerPhone,
      context,
    });
    recordEvent(session, 'call_started', { transport: options.transport });

    // Caller ID lookup, exactly as a receptionist's screen would do it. Doing
    // this up front means a returning customer is greeted by name and can book
    // without being asked for details already on file. Only the first name and
    // phone come back — the CRM withholds the rest from this credential.
    if (options.callerPhone) {
      try {
        const customer = await crm.findCustomerByPhone(options.callerPhone, { callId: call.id });
        if (customer) {
          session.customer = {
            id: customer.id,
            firstName: customer.firstName,
            phone: customer.phone,
          };
          recordEvent(session, 'intent_detected', { recognisedCaller: true });
        }
      } catch {
        // An unrecognised caller is a normal case, not a failure — carry on
        // and ask for their name.
      }
    }

    return new CallRunner(session, crm, llm);
  }

  greeting(): string {
    const text = greeting(this.session, this.session.customer?.firstName);
    this.session.transcript.push({ role: 'agent', text, at: new Date().toISOString() });
    return text;
  }

  handleUserTurn(text: string) {
    return this.orchestrator.handleUserTurn(text);
  }

  /**
   * Write what has happened so far, without ending the call.
   *
   * Called after each turn. Two reasons, both learned the hard way:
   *
   *  - A call only reaches the CRM when it *ends*, so a caller who books and
   *    then leaves the line open is invisible to the salon — their appointments
   *    appear with no call behind them. A live call should be reviewable while
   *    it is still live.
   *  - A call that is never cleanly hung up — tab closed, laptop shut, worker
   *    restarted — left an empty row and no transcript at all. Precisely the
   *    calls worth reading.
   *
   * Deliberately fire-and-forget: it runs after the caller has already been
   * answered, and a bookkeeping failure must never interrupt a conversation.
   */
  persistProgress(): void {
    if (this.summarised) return;

    void (async () => {
      try {
        await Promise.all([
          this.crm.updateCall(this.session.callId, { transcript: this.session.transcript }),
          this.crm.saveCallSummary(this.buildSummary()),
        ]);
      } catch (err) {
        this.log.warn({ err }, 'could not save call progress — will try again next turn');
      }
    })();
  }

  /**
   * Close the call. Idempotent, because a hang-up and an explicit end can race.
   */
  async end(status: 'completed' | 'failed' = 'completed'): Promise<void> {
    if (this.summarised) return;
    this.summarised = true;

    recordEvent(this.session, 'call_ended', { status, turns: this.session.turnCount });

    try {
      await this.crm.endCall(this.session.callId, {
        status,
        transcript: this.session.transcript,
      });
    } catch (err) {
      this.log.error({ err }, 'failed to close the call log');
    }

    try {
      await this.crm.saveCallSummary(this.buildSummary());
      this.log.info({ state: this.session.state }, 'call summary saved');
    } catch (err) {
      // Losing the summary is bad, but it must not take the process with it.
      this.log.error({ err }, 'failed to save the call summary');
    }
  }

  private buildSummary(): Record<string, unknown> {
    const s = this.session;
    const outcome = s.lastWriteOutcome;

    const appointmentAction = outcome?.action ?? (s.intents.includes('lookup') ? 'lookup' : 'none');
    const actionResult = outcome
      ? outcome.result === 'success'
        ? 'success'
        : 'failed'
      : 'not_attempted';

    // The database requires a reason whenever a failure is recorded, and an
    // indeterminate outcome is a failure that particularly needs explaining.
    const failureReason =
      actionResult === 'failed'
        ? outcome?.result === 'unknown'
          ? `Outcome unknown — ${outcome.code ?? 'no response'} from the CRM; the write may or may not have landed.`
          : `${outcome?.code ?? 'UNKNOWN'}: ${outcome?.message ?? 'no detail'}`
        : null;

    return {
      callId: s.callId,
      customerId: s.customer?.id ?? null,
      callerPhone: s.callerPhone,
      intents: s.intents.length > 0 ? s.intents : (['unknown'] satisfies CallIntent[]),
      servicesDiscussed: s.servicesDiscussed,
      appointmentAction,
      actionResult,
      failureReason,
      appointmentId: outcome?.result === 'success' ? (outcome.appointmentId ?? null) : null,
      summary: this.narrate(),
      keyEntities: {
        service: s.slots.serviceName ?? null,
        staff: s.slots.staffName ?? null,
        requestedWindow: s.slots.requestedWindow?.interpretation ?? null,
        confirmedFor: outcome?.appointmentLabel ?? null,
        customerFirstName: s.customer?.firstName ?? s.slots.customerName ?? null,
        turns: s.turnCount,
        finalState: s.state,
      },
      events: s.events,
      escalated: s.escalation !== null,
      escalationReason: s.escalation?.reason ?? null,
      callbackRequest: s.escalation?.callback ?? null,
    };
  }

  /** A short human summary, assembled from what actually happened. */
  private narrate(): string {
    const s = this.session;
    const who = s.customer?.firstName ?? s.slots.customerName ?? 'An unrecognised caller';
    const parts: string[] = [];

    const wanted = s.intents.filter((i) => i !== 'unknown');
    parts.push(
      wanted.length > 0
        ? `${who} called about ${wanted.join(', ')}.`
        : `${who} called; no clear request was established.`,
    );

    if (s.slots.serviceName) parts.push(`Discussed ${s.slots.serviceName}.`);
    if (s.slots.requestedWindow) parts.push(`Asked about ${s.slots.requestedWindow.interpretation}.`);

    const outcome = s.lastWriteOutcome;
    if (outcome?.result === 'success') {
      parts.push(`${capitalise(outcome.action)} completed${outcome.appointmentLabel ? ` for ${outcome.appointmentLabel}` : ''}.`);
    } else if (outcome?.result === 'failed') {
      parts.push(`Attempted to ${outcome.action} but it failed (${outcome.code}); the caller was told.`);
    } else if (outcome?.result === 'unknown') {
      parts.push(`Attempted to ${outcome.action}; the result could not be confirmed and needs checking.`);
    }

    if (s.escalation) parts.push(`Escalated: ${s.escalation.reason}.`);
    if (s.events.some((e) => e.type === 'guard_tripped')) {
      parts.push('A safety guard suppressed something the agent was about to say — worth reviewing.');
    }

    return parts.join(' ');
  }
}

const capitalise = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
