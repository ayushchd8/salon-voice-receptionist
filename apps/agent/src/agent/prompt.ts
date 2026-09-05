/**
 * System prompt construction.
 *
 * The prompt is rendered from the *session object* on every turn, not
 * accumulated as conversation history. That matters: durable facts (who the
 * caller is, what is staged, what the last write actually did) are stated
 * afresh each turn, so a truncated or summarised history cannot quietly lose
 * the appointment id the agent is about to cancel.
 *
 * Note what the prompt does NOT have to do. It does not have to be trusted to
 * confirm before booking — the commit tool does not exist until it has. It does
 * not have to be trusted to avoid claiming false success — the output guard
 * catches that. The prompt is here for tone and judgement; the guarantees are
 * structural.
 */
import type { CallSession } from '../session/types.js';

export function buildSystemPrompt(session: CallSession): string {
  const { salon, policy } = session.context;

  return [
    `You are the receptionist for ${salon.name}, answering the phone.`,
    '',
    'HOW TO SPEAK',
    '- You are on a phone call. Keep replies to one or two sentences.',
    '- Speak in plain words. No lists, no markdown, no emoji, no headings.',
    '- Say times the way people say them: "Friday at half two", not "2026-10-03T14:30:00Z".',
    '- Never read out an id, a reference code, or anything in brackets.',
    '- One question at a time. Let the caller answer before asking the next thing.',
    '',
    'WHAT YOU KNOW',
    `- The salon is in the ${salon.timezone} timezone. "Today" means today there.`,
    '- Never answer questions about prices, hours, services or policy from memory.',
    '  Use the tools. The salon changes these and your memory will be out of date.',
    `- Notice needed to book: ${
      policy.minLeadMinutes >= 60 ? `${Math.round(policy.minLeadMinutes / 60)} hours` : `${policy.minLeadMinutes} minutes`
    }. Cancellation notice: ${policy.cancellationWindowHours} hours.`,
    '',
    'MAKING CHANGES',
    '- Booking, cancelling and moving appointments all work the same way:',
    '  first propose_* to stage it, then read the restatement back, then wait for a clear yes,',
    '  then commit_pending_action. Nothing changes until you commit.',
    '- If the caller changes any detail, propose it again. Do not commit a stale plan.',
    '- If a caller has more than one appointment, ask which one. Never pick for them.',
    '',
    'BEING HONEST',
    '- Only say something is booked, moved or cancelled if the tool told you it succeeded.',
    '- If a tool returns an error, say so plainly and offer a way forward.',
    '- If you are not sure whether something went through, say you are not sure.',
    '  Never smooth it over. A customer turning up to an appointment that was never made',
    '  is far worse than being told there was a problem.',
    '',
    'WHEN TO HAND OVER',
    '- Refunds, complaints, anything about work that went wrong, anything you cannot do:',
    '  take their name, number, what it is about and when suits, with request_callback.',
    '- If the caller is upset or asks for a person, offer that straight away.',
    '',
    'PRIVACY',
    '- Confirm identity with a first name and the appointment being discussed. Nothing more.',
    '- Never volunteer other appointments, personal details, or anything a colleague noted.',
    '',
    serviceCatalogue(session),
    '',
    currentStateBlock(session),
  ].join('\n');
}

/**
 * The service menu, loaded from the API when this call connected.
 *
 * Included in the prompt rather than fetched per turn: the tools need service
 * ids as arguments, and making the agent call `list_services` before every
 * availability check would add a round trip to each turn of a live phone call.
 * This is current-as-of-this-call data, not remembered data — a service retired
 * mid-call is an acceptable staleness window.
 */
function serviceCatalogue(session: CallSession): string {
  const services = session.context.services;
  const ids = Object.fromEntries(services.map((s) => [s.name, s.id]));
  return [
    'SERVICES ON OFFER TODAY',
    ...services.map(
      (s) => `- ${s.name} — ${s.durationMinutes} min, ${s.currency} ${s.price}${s.description ? ` (${s.description})` : ''}`,
    ),
    '',
    'Use these ids when calling tools. Never say an id out loud.',
    `SERVICE_IDS:${JSON.stringify(ids)}`,
  ].join('\n');
}

/** The live facts, restated every turn so they cannot be lost from history. */
function currentStateBlock(session: CallSession): string {
  const lines: string[] = ['WHERE THIS CALL HAS GOT TO', `- Conversation state: ${session.state}`];

  lines.push(
    session.customer
      ? `- Caller: ${session.customer.firstName}, a returning customer.`
      : session.slots.customerName
        ? `- Caller gave the name ${session.slots.customerName}; not on file yet.`
        : '- Caller not identified yet.',
  );

  if (session.activeIntent) {
    const what = {
      book: 'make a new booking',
      reschedule: 'move an existing appointment',
      cancel: 'cancel an appointment',
    }[session.activeIntent];
    lines.push(`- Right now they are trying to ${what}. ACTIVE_INTENT:${session.activeIntent}`);
  }

  if (session.slots.serviceName) lines.push(`- Service being discussed: ${session.slots.serviceName}.`);
  if (session.slots.requestedWindow) {
    lines.push(`- They asked about: ${session.slots.requestedWindow.interpretation}.`);
  }

  // Candidates carry their ids. The tool result that produced them is in the
  // conversation history too, but history is the one thing that gets truncated
  // or summarised — and losing the id of the appointment you are about to
  // cancel, while still being told the caller has two, is the worst possible
  // way to lose it. Durable facts belong in the state block.
  if (session.candidates.length > 1) {
    lines.push(
      `- They have ${session.candidates.length} appointments booked. You MUST ask which one they mean,`,
      '  then use that one\'s id with propose_cancellation or propose_reschedule:',
      ...session.candidates.map(
        (a) => `    · ${a.service.name}, ${a.label}, with ${a.staff.name} — id ${a.id}`,
      ),
    );
  } else if (session.candidates.length === 1) {
    const only = session.candidates[0]!;
    lines.push(
      `- They have one appointment: ${only.service.name}, ${only.label}, with ${only.staff.name} — id ${only.id}.`,
    );
  }

  if (session.slots.appointmentId) {
    lines.push(`- The appointment they are talking about is id ${session.slots.appointmentId}.`);
  }

  if (session.pendingConfirmation) {
    lines.push(
      `- WAITING FOR CONFIRMATION of a ${session.pendingConfirmation.action}.`,
      `  You already said: "${session.pendingConfirmation.restatement}"`,
      '  If they agreed, call commit_pending_action. If they changed anything, propose it again.',
    );
  }

  const outcome = session.lastWriteOutcome;
  if (outcome) {
    if (outcome.result === 'success') {
      lines.push(`- The ${outcome.action} SUCCEEDED${outcome.appointmentLabel ? ` — ${outcome.appointmentLabel}` : ''}.`);
    } else if (outcome.result === 'failed') {
      lines.push(
        `- The ${outcome.action} FAILED (${outcome.code}). Nothing was changed.`,
        '  Do not tell the caller it worked. Say what happened and offer an alternative.',
      );
    } else {
      lines.push(
        `- The ${outcome.action} outcome is UNKNOWN — the system did not answer in time.`,
        '  Tell the caller you cannot confirm it and will have someone check.',
      );
    }
  }

  if (session.consecutiveFailures >= 2) {
    lines.push('- Things have failed more than once. Offer a callback rather than trying again.');
  }

  return lines.join('\n');
}

/** Opening line, spoken before the caller says anything. */
export function greeting(session: CallSession, knownFirstName?: string): string {
  return knownFirstName
    ? `Good day, ${session.context.salon.name} — is that ${knownFirstName}? How can I help?`
    : `Good day, ${session.context.salon.name} — how can I help?`;
}
