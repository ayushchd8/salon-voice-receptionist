/**
 * Tool definitions, and the rule for which of them exist on a given turn.
 *
 * The central safety property of this agent is here: **the tool list handed to
 * the model is computed from `session.state` on every turn.** `commit_pending_action`
 * is absent from the array entirely until the caller has been read the details
 * and said yes. The model cannot book without confirming because, at that
 * moment, there is no function for it to call.
 *
 * A system prompt saying "always confirm first" is a request. An absent tool is
 * a guarantee, and it survives a jailbreak, a confused model, and a prompt
 * regression.
 */
import type { ConversationState } from '../session/types.js';

export interface ToolDefinition {
  name: string;
  description: string;
  input_schema: {
    type: 'object';
    properties: Record<string, unknown>;
    required: string[];
    additionalProperties: false;
  };
}

const obj = (
  properties: Record<string, unknown>,
  required: string[] = [],
): ToolDefinition['input_schema'] => ({
  type: 'object',
  properties,
  required,
  additionalProperties: false,
});

const str = (description: string) => ({ type: 'string', description });

// ── information ───────────────────────────────────────────────────────────────

const getSalonInfo: ToolDefinition = {
  name: 'get_salon_info',
  description:
    'Opening hours, address, contact details and booking policy (notice required, ' +
    'cancellation window and fee, how far ahead customers can book). Use this to answer ' +
    'any question about when the salon is open or how booking works. Never answer these ' +
    'from memory — the salon can change them at any time.',
  input_schema: obj({}),
};

const listServices: ToolDefinition = {
  name: 'list_services',
  description:
    'The current service menu with prices and durations. Use this for "what do you do", ' +
    '"how much is X", "how long does Y take". Only services currently offered are returned.',
  input_schema: obj({
    category: str('Optional filter, e.g. "colour" or "hair".'),
  }),
};

const resolveTimeExpression: ToolDefinition = {
  name: 'resolve_time_expression',
  description:
    'Turn a vague time phrase the caller used ("next friday afternoon", "a week from ' +
    'tuesday", "sometime after 3") into concrete dates. Always use this rather than ' +
    'working out dates yourself. Read the returned `interpretation` back to the caller so ' +
    'they can correct you if it is not what they meant.',
  input_schema: obj(
    { expression: str('The caller\'s own words for when they want to come in.') },
    ['expression'],
  ),
};

const checkAvailability: ToolDefinition = {
  name: 'check_availability',
  description:
    'Find bookable times for a service. Pass the caller\'s phrase in `timeExpression` — it ' +
    'is resolved for you. If nothing is free, `alternatives` holds nearby times: offer two ' +
    'or three of those rather than telling the caller there is nothing.',
  input_schema: obj(
    {
      serviceId: str('The service id from list_services.'),
      timeExpression: str('When the caller wants to come in, in their own words.'),
      staffId: str('Only if the caller asked for a specific stylist.'),
    },
    ['serviceId', 'timeExpression'],
  ),
};

const identifyCaller: ToolDefinition = {
  name: 'identify_caller',
  description:
    'Look the caller up. Uses the number they are calling from by default; pass `name` if ' +
    'they are calling from a different phone. Returns their first name if they are already ' +
    'a customer, so you can greet them properly.',
  input_schema: obj({ name: str("The caller's name, if they gave one.") }),
};

const findAppointments: ToolDefinition = {
  name: 'find_appointments',
  description:
    'Find the caller\'s upcoming appointments. If more than one comes back, the result sets ' +
    '`requiresDisambiguation` — you must then ask which one they mean and never assume. ' +
    'Call this before proposing any cancellation or reschedule.',
  input_schema: obj({ phone: str('Only if different from the number they are calling from.') }),
};

/**
 * Records which service the caller has settled on.
 *
 * Same reasoning as select_appointment: a choice the caller has made must live
 * on the session, not in the model's head. Without it, "the second one" is
 * acknowledged, forgotten by the next turn, and the menu gets read out again.
 */
const selectService: ToolDefinition = {
  name: 'select_service',
  description:
    'Record which service the caller wants, once they have told you. Use this when they pick ' +
    'one but have not yet said when — then ask about timing. If they name a service and a time ' +
    'together, go straight to check_availability instead.',
  input_schema: obj({ serviceId: str('The service id from list_services.') }, ['serviceId']),
};

/**
 * Records which appointment the caller picked, once they have been asked.
 *
 * Exists so that resolving an ambiguity is an explicit, recorded step rather
 * than something the model is expected to keep in its head. It puts the chosen
 * id into the session — which the state block restates every turn — so the
 * choice survives a summarised history, and it leaves a `state_changed` entry
 * in the call trail showing exactly what the caller chose and when.
 */
const selectAppointment: ToolDefinition = {
  name: 'select_appointment',
  description:
    'Record which appointment the caller means, after they have told you. Pass the ' +
    '`appointmentId` from find_appointments. Use this as soon as they have chosen, before ' +
    'looking for a new time or proposing anything. It changes nothing about the booking.',
  input_schema: obj(
    { appointmentId: str('The id of the appointment they chose, from find_appointments.') },
    ['appointmentId'],
  ),
};

// ── staging: proposes, never writes ───────────────────────────────────────────

const proposeBooking: ToolDefinition = {
  name: 'propose_booking',
  description:
    'Stage a booking and get the exact wording to read back. This does NOT book anything. ' +
    'Call it once you know the service, the time and who the appointment is for. It returns ' +
    'a `restatement` — say that to the caller and ask them to confirm.',
  input_schema: obj(
    {
      serviceId: str('The service id from list_services.'),
      start: str('The exact `start` value of the slot the caller chose, from check_availability.'),
      staffId: str('The `staffId` of the chosen slot.'),
      customerFirstName: str("The caller's first name — required for a caller we do not know."),
      customerPhone: str('Their phone number, if we do not already have it.'),
    },
    ['serviceId', 'start'],
  ),
};

const proposeCancellation: ToolDefinition = {
  name: 'propose_cancellation',
  description:
    'Stage a cancellation of one specific appointment. This does NOT cancel anything. ' +
    'You must pass the `appointmentId` of an appointment returned by find_appointments — if ' +
    'the caller has more than one, ask which before calling this. Returns a `restatement` to ' +
    'read back, including any late-cancellation fee.',
  input_schema: obj(
    {
      appointmentId: str('The id of the appointment to cancel, from find_appointments.'),
      reason: str('The reason the caller gave, if any.'),
    },
    ['appointmentId'],
  ),
};

const proposeReschedule: ToolDefinition = {
  name: 'propose_reschedule',
  description:
    'Stage a move of one specific appointment to a new time. This does NOT move anything. ' +
    'Requires the `appointmentId` and the `start` of a slot from check_availability. ' +
    'Returns a `restatement` to read back.',
  input_schema: obj(
    {
      appointmentId: str('The id of the appointment to move, from find_appointments.'),
      start: str('The `start` value of the new slot, from check_availability.'),
      staffId: str('The `staffId` of the new slot.'),
      serviceId: str('Only if the caller is also changing the service.'),
    },
    ['appointmentId', 'start'],
  ),
};

/**
 * The only tool that changes data.
 *
 * It takes **no details** — the payload was frozen when the action was staged
 * and read back to the caller. The agent therefore cannot commit anything other
 * than exactly what the caller agreed to, even if the conversation has drifted
 * since.
 */
const commitPendingAction: ToolDefinition = {
  name: 'commit_pending_action',
  description:
    'Carry out the action you already read back to the caller, now that they have clearly ' +
    'agreed. Takes no details: it performs precisely what was confirmed. Only call this ' +
    'after an explicit yes. If the caller changed anything, do not call this — propose the ' +
    'amended action again instead.',
  input_schema: obj(
    { callerConfirmed: { type: 'boolean', description: 'True only if the caller explicitly agreed.' } },
    ['callerConfirmed'],
  ),
};

// ── escalation ────────────────────────────────────────────────────────────────

const requestCallback: ToolDefinition = {
  name: 'request_callback',
  description:
    'Hand the caller to a human. Use when the request is outside what a receptionist can do ' +
    '(refunds, complaints, anything about a previous service going wrong), when the caller ' +
    'is upset and wants a person, or when something has failed repeatedly. Collect their ' +
    'name, number, what it is about and when suits them.',
  input_schema: obj(
    {
      name: str('The caller\'s name.'),
      phone: str('The best number to reach them on.'),
      reason: str('What they need, in enough detail for the person calling back.'),
      preferredTime: str('When they would like to be called.'),
    },
    ['name', 'phone', 'reason'],
  ),
};

const endCall: ToolDefinition = {
  name: 'end_call',
  description: 'Close the call once everything is dealt with and the caller has said goodbye.',
  input_schema: obj({ farewell: str('What to say as you hang up.') }),
};

// ── state → available tools ───────────────────────────────────────────────────

const INFORMATION_TOOLS = [
  getSalonInfo, listServices, resolveTimeExpression, checkAvailability, identifyCaller,
  findAppointments, selectAppointment, selectService,
];
const STAGING_TOOLS = [proposeBooking, proposeCancellation, proposeReschedule];
const ALWAYS = [requestCallback, endCall];

/**
 * The tools the model may call given where the conversation is.
 *
 * Note what is *not* here: `commit_pending_action` appears only in CONFIRMING,
 * and only when something is actually staged.
 */
export function toolsForState(
  state: ConversationState,
  /**
   * True only when something is staged *and* the caller has had a turn to
   * answer the restatement. See `PendingConfirmation.stagedOnTurn`.
   */
  canCommit: boolean,
): ToolDefinition[] {
  switch (state) {
    case 'EXECUTING':
      // Nothing to offer mid-write; the result decides what happens next.
      return ALWAYS;

    case 'ESCALATION':
      return ALWAYS;

    case 'CLOSING':
      return [endCall];

    default: {
      // Staging tools stay available throughout so the caller can amend rather
      // than agree.
      const base = [...INFORMATION_TOOLS, ...STAGING_TOOLS, ...ALWAYS];

      // The commit tool's availability follows the staged action, not the
      // state name. A write that failed leaves the state at RESULT_FAILED with
      // the action still staged for retry — gating on CONFIRMING alone made
      // that retry unreachable, so every subsequent "yes" was answered with
      // "shall I go ahead?" forever.
      return canCommit ? [commitPendingAction, ...base] : base;
    }
  }
}

export const ALL_TOOLS = [
  ...INFORMATION_TOOLS, ...STAGING_TOOLS, commitPendingAction, ...ALWAYS,
];

export const WRITE_TOOL_NAMES = new Set(['commit_pending_action']);
