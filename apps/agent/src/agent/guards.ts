/**
 * Output guards.
 *
 * The requirement is absolute: the agent must never tell a customer that
 * something was booked, moved or cancelled unless the CRM actually said so.
 *
 * The tool layer already records the truth in `session.lastWriteOutcome`,
 * taken from the HTTP response. This is the second line of defence — it reads
 * that record and inspects what the model is about to say. If the write failed
 * (or its outcome is unknown) and the utterance claims success anyway, the
 * utterance is replaced with an honest one.
 *
 * Belt and braces on purpose. A prompt instruction is a strong nudge, but the
 * failure it guards against — a customer arriving at a salon for an
 * appointment that does not exist — is bad enough to be worth a check that
 * cannot be argued out of by a persuasive-sounding model.
 */
import type { CallSession, WriteOutcome } from '../session/types.js';
import { recordEvent } from '../session/types.js';
import { logger } from '../logger.js';

/**
 * Phrases that assert a completed change. Deliberately narrow: the goal is to
 * catch confident false claims, not to police ordinary conversation. Note the
 * negative lookbehind for "not"/"n't" so "that has not been booked" passes.
 */
const SUCCESS_CLAIM =
  /\b(?<!not )(?<!n't )(?:you'?re (?:booked|all set|in the (?:diary|book))|(?:i'?ve|i have|that'?s|it'?s) (?:booked|cancelled|canceled|moved|rescheduled|been (?:booked|cancelled|canceled|moved|rescheduled))|booked you in|all set|see you (?:then|on)|that'?s (?:done|sorted|confirmed)|confirmed for you)\b/i;

/** Explicit disclaimers that make an otherwise-suspicious sentence honest. */
const HONEST_MARKER =
  /\b(?:not|couldn'?t|could not|wasn'?t|was not|didn'?t|did not|unable|failed|sorry|unfortunately|problem|issue|afraid|unsure|not sure|check(?:ing)?)\b/i;

export interface GuardResult {
  text: string;
  tripped: boolean;
  reason?: string;
}

export function guardUtterance(session: CallSession, utterance: string): GuardResult {
  const outcome = session.lastWriteOutcome;
  if (!outcome || outcome.result === 'success') return { text: utterance, tripped: false };

  // A failed or indeterminate write is on the record. Does the agent claim otherwise?
  if (!SUCCESS_CLAIM.test(utterance)) return { text: utterance, tripped: false };
  if (HONEST_MARKER.test(utterance)) return { text: utterance, tripped: false };

  const replacement = honestReplacement(outcome);
  logger.error(
    { callId: session.callId, action: outcome.action, code: outcome.code, result: outcome.result },
    'output guard tripped — suppressed a false claim of success',
  );
  recordEvent(session, 'guard_tripped', {
    guard: 'no_false_success',
    action: outcome.action,
    outcome: outcome.result,
    code: outcome.code,
    suppressed: utterance,
  });

  return { text: replacement, tripped: true, reason: 'false_success_claim' };
}

/**
 * What to say instead. Specific about what happened, and always offering a
 * next step — a customer told only "that failed" has nowhere to go.
 */
function honestReplacement(outcome: WriteOutcome): string {
  const verb = { book: 'book that in', cancel: 'cancel that', reschedule: 'move that' }[outcome.action];

  if (outcome.result === 'unknown') {
    return (
      `I'm sorry — I couldn't get confirmation back from our system, so I can't tell you for ` +
      `certain whether that went through. I'll have someone check and call you back to confirm. ` +
      `Can I take the best number for you?`
    );
  }

  if (outcome.alternatives && outcome.alternatives.length > 0) {
    const options = outcome.alternatives.slice(0, 3).map((s) => s.label).join(', or ');
    return `I'm sorry — I couldn't ${verb}; that time has just gone. I do have ${options}. Would any of those work?`;
  }

  switch (outcome.code) {
    case 'SLOT_UNAVAILABLE':
    case 'NO_STAFF_AVAILABLE':
      return `I'm sorry — I couldn't ${verb}, that time isn't free after all. Shall I look at another day for you?`;
    case 'CANCELLATION_WINDOW_PASSED':
      return `I wasn't able to ${verb} without a late cancellation fee applying. Would you like me to go ahead anyway?`;
    case 'APPOINTMENT_NOT_MODIFIABLE':
      return `I'm sorry — that appointment can't be changed any more. Let me put you through to someone who can help.`;
    default:
      return (
        `I'm sorry — I wasn't able to ${verb}. Something went wrong at our end, so nothing has ` +
        `changed. Would you like me to take your details and have someone call you back?`
      );
  }
}

/**
 * Second guard: PII minimisation on the way out.
 *
 * The CRM already withholds staff notes, email addresses and surnames from the
 * agent's credential, so this cannot normally trigger. It exists because the
 * cost of it being wrong is a customer's private medical or personal note being
 * read aloud to whoever happens to be holding their phone.
 */
const SENSITIVE_HINT = /\b(?:allergic to|allergy|patch test|medical|no[- ]showed|card on file|complaint)\b/i;

export function guardPrivacy(session: CallSession, utterance: string): GuardResult {
  if (!SENSITIVE_HINT.test(utterance)) return { text: utterance, tripped: false };

  logger.error({ callId: session.callId }, 'privacy guard tripped — suppressed sensitive detail');
  recordEvent(session, 'guard_tripped', { guard: 'pii_minimisation', suppressed: utterance });

  return {
    text: "Let me just check that with a colleague — is there anything else I can help you with in the meantime?",
    tripped: true,
    reason: 'sensitive_detail',
  };
}

export function applyGuards(session: CallSession, utterance: string): GuardResult {
  const truthful = guardUtterance(session, utterance);
  const privacy = guardPrivacy(session, truthful.text);
  return {
    text: privacy.text,
    tripped: truthful.tripped || privacy.tripped,
    ...(truthful.reason ?? privacy.reason ? { reason: truthful.reason ?? privacy.reason } : {}),
  };
}
