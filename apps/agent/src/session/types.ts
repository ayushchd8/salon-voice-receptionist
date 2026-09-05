import type {
  Appointment,
  BookingPolicy,
  BusinessHoursResponse,
  CallEvent,
  CallIntent,
  CallbackRequest,
  Salon,
  Service,
  Slot,
  StaffMember,
  TranscriptTurn,
} from '@salon/contracts';

/**
 * Conversation states.
 *
 * These are not decorative. `state` decides which tools are handed to the model
 * on each turn, so the state machine is what makes "never book without
 * confirming" a structural property rather than a hopeful prompt instruction.
 */
export const CONVERSATION_STATES = [
  'GREETING',
  'IDENTIFYING',
  'ROUTING',
  'FAQ',
  'LOOKUP',
  'DISAMBIGUATION',
  'AVAILABILITY',
  'COLLECTING',
  'CONFIRMING',
  'EXECUTING',
  'RESULT_SUCCESS',
  'RESULT_FAILED',
  'ESCALATION',
  'CLOSING',
] as const;

export type ConversationState = (typeof CONVERSATION_STATES)[number];

export type WriteAction = 'book' | 'cancel' | 'reschedule';

/**
 * A staged write, awaiting the caller's explicit yes.
 *
 * The idempotency key is minted **here**, when the action is staged — not when
 * it is sent. Every retry of this action reuses it, so a booking that timed out
 * but actually succeeded replays instead of duplicating.
 */
export interface PendingConfirmation {
  action: WriteAction;
  /** The exact request body that will be sent, frozen at staging time. */
  payload: Record<string, unknown>;
  appointmentId?: string;
  idempotencyKey: string;
  /** What the agent must read back to the caller before acting. */
  restatement: string;
  stagedAt: string;
  /**
   * The turn on which this was staged.
   *
   * Committing requires a *later* turn, so the caller has actually had the
   * chance to hear the restatement and answer it. Without this, a model that
   * calls propose_* and commit_pending_action in the same turn books something
   * the caller was never read.
   */
  stagedOnTurn: number;
}

/**
 * The authoritative record of what a write actually did.
 *
 * Set by the tool layer from the HTTP response — never inferred from anything
 * the model said. The output guard reads this to decide whether the agent is
 * allowed to claim success.
 */
export interface WriteOutcome {
  action: WriteAction;
  result: 'success' | 'failed' | 'unknown';
  code?: string;
  message?: string;
  appointmentId?: string;
  appointmentLabel?: string;
  /** Alternatives the API offered when the requested time was unavailable. */
  alternatives?: Slot[];
  at: string;
}

export interface ToolCallRecord {
  name: string;
  input: Record<string, unknown>;
  outcome: 'success' | 'error';
  latencyMs: number;
  errorCode?: string;
  at: string;
}

/** Static salon facts, loaded once per call and reused every turn. */
export interface SalonContext {
  salon: Salon;
  services: Service[];
  staff: StaffMember[];
  hours: BusinessHoursResponse;
  policy: BookingPolicy;
}

export interface CallSession {
  callId: string;
  transport: 'browser' | 'twilio' | 'test';
  callerPhone: string | null;
  startedAt: string;

  state: ConversationState;

  /**
   * Minimum viable identity. The agent is given a first name and a phone, and
   * deliberately not a surname, an email address or staff notes — see the
   * projection in the CRM's customer serializer.
   */
  customer: { id: string; firstName: string; phone: string } | null;

  intents: CallIntent[];
  servicesDiscussed: string[];

  /**
   * What the caller is trying to do *right now*, as opposed to `intents`, which
   * accumulates everything the call has touched.
   *
   * Needed because "the first one" means different things depending on it: pick
   * a slot for a new booking, or a slot to move an existing appointment to.
   * Inferring that from whether an appointment id happens to be in scope got it
   * wrong straight after a booking, when the id of the appointment just created
   * is legitimately still there.
   *
   * Cleared once a write completes: the request is done.
   */
  activeIntent: 'book' | 'reschedule' | 'cancel' | null;

  /** Facts gathered so far. Durable, so a summarised history cannot lose them. */
  slots: {
    serviceId?: string;
    serviceName?: string;
    staffId?: string;
    staffName?: string;
    requestedWindow?: { from: string; to: string; interpretation: string };
    chosenSlot?: Slot;
    appointmentId?: string;
    customerName?: string;
  };

  /** Populated when a lookup returns more than one match. Never auto-resolved. */
  candidates: Appointment[];

  pendingConfirmation: PendingConfirmation | null;
  lastWriteOutcome: WriteOutcome | null;

  toolCalls: ToolCallRecord[];
  events: CallEvent[];
  transcript: TranscriptTurn[];

  /** Drives escalation after repeated failure rather than looping forever. */
  consecutiveFailures: number;
  turnCount: number;

  /**
   * Fingerprint of the previous turn (state + tools used), and how many turns
   * in a row have looked identical. A conversation that keeps producing the
   * same tool call and the same state is not progressing, however fluent it
   * sounds — see the stall guard in the orchestrator.
   */
  lastTurnSignature: string | null;
  stalledTurns: number;

  escalation: { reason: string; callback?: CallbackRequest } | null;
  ended: boolean;

  context: SalonContext;
}

export function createSession(args: {
  callId: string;
  transport: CallSession['transport'];
  callerPhone: string | null;
  context: SalonContext;
}): CallSession {
  return {
    callId: args.callId,
    transport: args.transport,
    callerPhone: args.callerPhone,
    startedAt: new Date().toISOString(),
    state: 'GREETING',
    customer: null,
    intents: [],
    servicesDiscussed: [],
    activeIntent: null,
    slots: {},
    candidates: [],
    pendingConfirmation: null,
    lastWriteOutcome: null,
    toolCalls: [],
    events: [],
    transcript: [],
    consecutiveFailures: 0,
    turnCount: 0,
    lastTurnSignature: null,
    stalledTurns: 0,
    escalation: null,
    ended: false,
    context: args.context,
  };
}

export function recordEvent(
  session: CallSession,
  type: CallEvent['type'],
  detail: Record<string, unknown>,
  extra: { latencyMs?: number; outcome?: 'success' | 'error' } = {},
): void {
  session.events.push({
    at: new Date().toISOString(),
    type,
    detail,
    ...(extra.latencyMs !== undefined ? { latencyMs: extra.latencyMs } : {}),
    ...(extra.outcome ? { outcome: extra.outcome } : {}),
  });
}

export function transition(session: CallSession, next: ConversationState, why: string): void {
  if (session.state === next) return;
  recordEvent(session, 'state_changed', { from: session.state, to: next, why });
  session.state = next;
}

export function addIntent(session: CallSession, intent: CallIntent): void {
  if (!session.intents.includes(intent)) {
    session.intents.push(intent);
    recordEvent(session, 'intent_detected', { intent });
  }
}

export function addTurn(session: CallSession, role: TranscriptTurn['role'], text: string): void {
  session.transcript.push({ role, text, at: new Date().toISOString() });
}
