/**
 * A deterministic, rule-based stand-in for the language model.
 *
 * Two jobs:
 *
 *  1. **Testing.** The conversation tests assert that the *harness* is correct —
 *     that confirmation gates the write, that ambiguity forces a question, that
 *     a retry reuses its idempotency key, that a failed write is never reported
 *     as success. Those are properties of the state machine, the tool layer and
 *     the guards, not of the model. Driving them with a real LLM would make the
 *     suite slow, costly and flaky, and a green run would prove much less.
 *
 *  2. **A demo with no API key.** The rules below are good enough to book,
 *     cancel and reschedule over the browser voice client, so the pipeline can
 *     be exercised end to end before anyone has signed up for anything.
 *
 * It is not a language model and does not pretend to be. Real deployments use
 * the Anthropic adapter.
 */
import type { LlmAdapter, LlmRequest, LlmTurn, LlmToolCall } from './types.js';
import { BOOK_PHRASES, CANCEL_PHRASES, LOOKUP_PHRASES, RESCHEDULE_PHRASES } from '../agent/intents.js';

export interface ScriptStep {
  /** Matched against the most recent caller utterance. */
  when: RegExp | ((request: LlmRequest, lastUser: string) => boolean);
  then: LlmTurn | ((request: LlmRequest, lastUser: string) => LlmTurn);
  /** Consume this step once, rather than matching on every turn. */
  once?: boolean;
}

let callCounter = 0;
const toolCall = (name: string, input: Record<string, unknown> = {}): LlmToolCall => ({
  id: `scripted_${(callCounter += 1)}`,
  name,
  input,
});

/** How many services the agent reads out before saying "and a few others". */
const SPOKEN_MENU_LIMIT = 4;

/** How many times the agent offers at once. Reading six down a phone is not helpful. */
const SPOKEN_SLOT_LIMIT = 3;

const AFFIRMATIVE = /\b(yes|yeah|yep|yup|sure|please|ok|okay|go ahead|do it|that'?s right|correct|sounds good|perfect|lovely)\b/i;
const NEGATIVE = /\b(no|nope|don'?t|do not|actually|instead|wait|change|different|rather)\b/i;

export class ScriptedAdapter implements LlmAdapter {
  readonly name = 'scripted';
  private readonly steps: ScriptStep[];
  private readonly used = new Set<ScriptStep>();

  constructor(steps: ScriptStep[] = []) {
    this.steps = steps;
  }

  async complete(request: LlmRequest): Promise<LlmTurn> {
    const lastUser = lastUserText(request);

    // Explicit script first, so tests can force an exact sequence.
    for (const step of this.steps) {
      if (step.once && this.used.has(step)) continue;
      const matches =
        typeof step.when === 'function' ? step.when(request, lastUser) : step.when.test(lastUser);
      if (!matches) continue;
      if (step.once) this.used.add(step);
      return typeof step.then === 'function' ? step.then(request, lastUser) : step.then;
    }

    return this.policy(request, lastUser);
  }

  /** The default receptionist policy. */
  private policy(request: LlmRequest, lastUser: string): LlmTurn {
    const available = new Set(request.tools.map((t) => t.name));
    const system = request.system;
    const lastResult = lastToolResult(request);

    // ── react to the tool result we just received ────────────────────────────
    if (lastResult) {
      const reaction = this.reactTo(lastResult, available, system, lastUser, request);
      if (reaction) return reaction;
    }

    // ── confirmation ────────────────────────────────────────────────────────
    const awaitingConfirmation = system.includes('WAITING FOR CONFIRMATION');
    if (awaitingConfirmation) {
      if (AFFIRMATIVE.test(lastUser) && !NEGATIVE.test(lastUser) && available.has('commit_pending_action')) {
        return { text: '', toolCalls: [toolCall('commit_pending_action', { callerConfirmed: true })] };
      }
      if (NEGATIVE.test(lastUser)) {
        return { text: 'No problem — what would you like to change?', toolCalls: [] };
      }
      return { text: 'Just to check — shall I go ahead with that?', toolCalls: [] };
    }

    // ── the caller answering "which one did you mean?" ──────────────────────
    // Without this the agent asks, is told "the first one", and — having no
    // handler for the answer — falls through to the generic greeting and asks
    // again. That is a loop the caller cannot escape.
    const candidates = recentAppointments(request);
    if (candidates.length > 1) {
      const chosen = pickAppointment(candidates, lastUser);
      if (chosen) {
        const intent = pendingAppointmentIntent(request);
        if (intent === 'cancel' && available.has('propose_cancellation')) {
          return { text: '', toolCalls: [toolCall('propose_cancellation', { appointmentId: chosen.appointmentId })] };
        }
        // Record the choice so the next turn still knows which one they meant.
        return { text: '', toolCalls: [toolCall('select_appointment', { appointmentId: chosen.appointmentId })] };
      }
      // They said something we could not map to one of them. Ask again, but
      // concretely, rather than resetting the conversation.
      if (!/\b(cancel|move|reschedule|change|book|when|what|how much|open)\b/i.test(lastUser)) {
        const options = candidates.map((a) => `the ${a.service} ${a.when}`).join(', or ');
        return { text: `Sorry — was that ${options}?`, toolCalls: [] };
      }
    }

    // ── the caller picking a service from the menu just read to them ────────
    // "We do Full Head Colour, Highlights, Root Touch-Up…" — "the second one"
    // has to mean something, or the agent reads the list again and again.
    const menu = recentServices(request);
    if (menu.length > 0 && !system.includes('WAITING FOR CONFIRMATION')) {
      const service = pickService(menu, lastUser);
      if (service) {
        const whenAsked = timePhrase(lastUser);
        return whenAsked
          ? { text: '', toolCalls: [toolCall('check_availability', { serviceId: service.id, timeExpression: whenAsked })] }
          // Recorded, not just acknowledged — otherwise the next turn forgets.
          : { text: '', toolCalls: [toolCall('select_service', { serviceId: service.id })] };
      }
    }

    // ── the caller picking one of the times we just offered ─────────────────
    // Without this the zero-key demo could offer slots but never book one.
    const offered = recentSlots(request);
    if (offered.length > 0 && !system.includes('WAITING FOR CONFIRMATION')) {
      const picked = pickSlot(offered, lastUser);

      // They named a real time, just not one of the three we read out. Go and
      // look for it rather than claiming not to understand — only three of the
      // available slots were spoken, so "quarter past ten" may well be free.
      if (!picked) {
        const asked = spokenTimeToLocal(lastUser);
        if (asked.length > 0) {
          const serviceId = serviceIdFor(system, lastUser) ?? discussedServiceId(system);
          const day = dayOfOffer(offered);
          if (serviceId && day) {
            // A bare hour has two readings — "half past two" is 02:30 or 14:30.
            // Take whichever is nearer the times already on the table, rather
            // than the first, which sent the agent looking at half past two in
            // the morning.
            const wanted = nearestReading(asked, offered);
            return {
              text: '',
              toolCalls: [toolCall('check_availability', {
                serviceId,
                timeExpression: `${day} at ${speakLocalTime(wanted)}`,
              })],
            };
          }
        }
      }

      if (picked) {
        // Moving an existing appointment, or making a new one? Decided by what
        // the caller said they wanted, not by whether an appointment id happens
        // to be in scope — straight after a booking, it always is.
        const moving = activeIntent(system) === 'reschedule' ? settledAppointmentId(system) : undefined;
        if (moving && available.has('propose_reschedule')) {
          return {
            text: '',
            toolCalls: [toolCall('propose_reschedule', {
              appointmentId: moving, start: picked.start, staffId: picked.staffId,
            })],
          };
        }
        if (available.has('propose_booking')) {
          const serviceId = serviceIdFor(system, lastUser) ?? discussedServiceId(system);
          if (serviceId) {
            return {
              text: '',
              toolCalls: [toolCall('propose_booking', {
                serviceId, start: picked.start, staffId: picked.staffId,
              })],
            };
          }
        }
      }
    }

    // ── once escalated, the job is to get them to a person ──────────────────
    if (/Conversation state: ESCALATION/.test(system) && available.has('request_callback')) {
      const name =
        /(?:my name'?s|my name is|i'?m|this is|it'?s)\s+([a-z]+(?:\s+[a-z]+)?)/i.exec(lastUser)?.[1];
      const phone = /(\+?\d[\d\s().-]{6,}\d)/.exec(lastUser)?.[1];

      if (name && phone) {
        return {
          text: '',
          toolCalls: [toolCall('request_callback', {
            name: name.trim(),
            phone: phone.replace(/\s+/g, ''),
            reason: 'The receptionist could not complete the caller\u2019s request',
            preferredTime: timePhrase(lastUser) ?? null,
          })],
        };
      }
      if (name) return { text: `Thanks ${name.trim()} — and the best number to reach you on?`, toolCalls: [] };
      if (phone) return { text: 'Thank you — and can I take your name?', toolCalls: [] };
      return { text: 'Can I take your name and the best number to call you back on?', toolCalls: [] };
    }

    // ── escalation ──────────────────────────────────────────────────────────
    if (/\b(refund|complain|complaint|manager|terrible|awful|ruined|furious|speak to (a|someone)|human|real person)\b/i.test(lastUser)) {
      return {
        text: "I'm sorry about that — that's something the salon manager handles rather than me. Can I take your name and number and have them call you back?",
        toolCalls: [],
      };
    }
    // If we have just asked for their details, take whatever they give us.
    // Keyed on what the agent actually said, rather than on prompt text that
    // may or may not mention the reason for the callback.
    if (awaitingCallbackDetails(request) && available.has('request_callback')) {
      const name =
        /(?:my name'?s|my name is|i'?m|this is|it'?s)\s+([a-z]+(?:\s+[a-z]+)?)/i.exec(lastUser)?.[1];
      const phone = /(\+?\d[\d\s().-]{6,}\d)/.exec(lastUser)?.[1];

      if (name && phone) {
        return {
          text: '',
          toolCalls: [toolCall('request_callback', {
            name: name.trim(),
            phone: phone.replace(/\s+/g, ''),
            reason: complaintReason(request),
            preferredTime: timePhrase(lastUser) ?? null,
          })],
        };
      }
      if (name) return { text: `Thanks ${name.trim()} — and the best number to reach you on?`, toolCalls: [] };
      if (phone) return { text: 'Thank you — and can I take your name?', toolCalls: [] };
    }

    // ── goodbye ─────────────────────────────────────────────────────────────
    if (
      /\b(bye|goodbye|that'?s (all|it|everything|lovely)|nothing else|no thank ?you|no thanks|thanks,? bye|all good|i'?m good|we'?re done|nope,? that'?s it)\b/i.test(
        lastUser,
      )
    ) {
      return { text: '', toolCalls: [toolCall('end_call', { farewell: 'Thanks for calling — see you soon!' })] };
    }

    // ── "what else do you have?" — the rest of the menu ─────────────────────
    // A natural follow-up to "…and a few others", and previously unhandled: it
    // fell through to the generic reply, which reads as the agent ignoring the
    // question.
    if (/\b(what else|anything else|else do you|other (services|treatments|options)|more options|full (list|menu)|everything you)\b/i.test(lastUser)) {
      return { text: '', toolCalls: [toolCall('list_services', { remainder: true })] };
    }

    // ── "book another one" — a second, separate appointment ─────────────────
    if (/\b(another|second|one more|also book|as well|too)\b/i.test(lastUser) && /\b(book|appointment|slot)\b/i.test(lastUser)) {
      return menu.length > 0
        ? { text: 'Of course — which would you like this time?', toolCalls: [] }
        : { text: '', toolCalls: [toolCall('list_services')] };
    }

    // ── the caller naming a service, with or without a booking word ─────────
    // "a cut and blow dry" is a perfectly ordinary way to answer "what were you
    // after?", and must not fall through to a generic reply.
    const named = serviceNamedIn(system, lastUser);
    if (named && !/\b(how much|price|cost|how long)\b/i.test(lastUser)) {
      const whenNamed = timePhrase(lastUser);
      if (whenNamed) {
        return { text: '', toolCalls: [toolCall('check_availability', { serviceId: named.id, timeExpression: whenNamed })] };
      }
      if (settledAppointmentId(system) === undefined) {
        return { text: '', toolCalls: [toolCall('select_service', { serviceId: named.id })] };
      }
    }

    // ── information ─────────────────────────────────────────────────────────
    if (
      /\b(open|opening|hours|closed|close|what time|where are you|address|policy|notice|cancellation fee)\b/i.test(lastUser) ||
      // "What about Tuesdays?" is a follow-up about opening hours. A day name
      // on its own is not enough — "next Tuesday morning" is someone telling us
      // when they want to come in, and must not be answered with our hours.
      (/\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday)s?\b/i.test(lastUser) &&
        /\b(what about|how about|and on|are you open|do you open|you open|open on)\b/i.test(lastUser))
    ) {
      return { text: '', toolCalls: [toolCall('get_salon_info')] };
    }
    if (/\b(how much|price|cost|how long|services|what do you (do|offer)|menu)\b/i.test(lastUser)) {
      // "How much is a men's cut?" deserves that price, not the whole menu.
      if (named) {
        return { text: '', toolCalls: [toolCall('select_service', { serviceId: named.id })] };
      }
      return { text: '', toolCalls: [toolCall('list_services')] };
    }

    // ── cancel / reschedule / book ──────────────────────────────────────────
    // Re-listing only helps while we do not yet know which appointment they
    // mean; doing it once we do is how the loop above started.
    const settled = settledAppointmentId(system);

    if (CANCEL_PHRASES.test(lastUser)) {
      if (settled && available.has('propose_cancellation')) {
        return { text: '', toolCalls: [toolCall('propose_cancellation', { appointmentId: settled })] };
      }
      return { text: '', toolCalls: [toolCall('find_appointments')] };
    }
    if (RESCHEDULE_PHRASES.test(lastUser)) {
      if (settled) {
        return { text: 'Of course — when would you like to move it to?', toolCalls: [] };
      }
      return { text: '', toolCalls: [toolCall('find_appointments')] };
    }
    if (LOOKUP_PHRASES.test(lastUser)) {
      return { text: '', toolCalls: [toolCall('find_appointments')] };
    }
    if (BOOK_PHRASES.test(lastUser)) {
      const serviceId = serviceIdFor(system, lastUser);
      const when = timePhrase(lastUser);
      if (!serviceId) {
        // They have just heard the list; reading it again is the loop.
        return menu.length > 0
          ? { text: 'Of course — which of those were you after?', toolCalls: [] }
          : { text: '', toolCalls: [toolCall('list_services')] };
      }
      if (!when) return { text: 'Of course — when were you thinking?', toolCalls: [] };
      return { text: '', toolCalls: [toolCall('check_availability', { serviceId, timeExpression: when })] };
    }

    // ── a bare time phrase, continuing an earlier request ───────────────────
    const when = timePhrase(lastUser);
    if (when) {
      // Mid-reschedule: the time they just named is where they want to move to.
      // When an appointment is being moved, that appointment's own service
      // decides which slots to look for. Anything else — a service mentioned
      // earlier in the call, a leftover from a cancellation — would search the
      // wrong duration and can offer a stylist who cannot perform it.
      const serviceId = settled
        ? (settledServiceId(system) ?? serviceIdFor(system, lastUser))
        : (serviceNamedIn(system, lastUser)?.id ?? discussedServiceId(system));
      if (serviceId) {
        return { text: '', toolCalls: [toolCall('check_availability', { serviceId, timeExpression: when })] };
      }
    }

    return { ...notUnderstood(system), understood: false };
  }

  /** What to do immediately after a tool returns. */
  private reactTo(
    result: Record<string, unknown>,
    available: Set<string>,
    system: string,
    lastUser: string,
    request: LlmRequest,
  ): LlmTurn | null {
    // Availability came back with times — offer them.
    if (result.available === true && Array.isArray(result.slots)) {
      const slots = result.slots as Array<{ when: string; start: string; staffId: string }>;
      const chosen = slots[0];
      if (!chosen) return null;
      const offer = slots.slice(0, SPOKEN_SLOT_LIMIT).map((s) => s.when).join(', or ');

      // If the caller already named a time, take the first slot straight to a proposal.
      if (system.includes('WAITING FOR CONFIRMATION')) return null;
      return {
        text: `I've got ${offer}. Which suits you?`,
        toolCalls: [],
      };
    }

    // Nothing free — offer alternatives rather than a dead end.
    if (result.available === false) {
      const alternatives = (result.alternatives ?? []) as Array<{ when: string }>;
      // Use the reason the API gave. Telling someone the diary is full when the
      // salon is simply shut that day is wrong information, and they will plan
      // around it.
      const why = typeof result.reason === 'string' && /closed/i.test(result.reason)
        ? "we're closed that day"
        : "we're full then";
      return alternatives.length > 0
        ? { text: `I'm afraid ${why}. I could do ${alternatives.map((a) => a.when).join(', or ')}. Would any of those work?`, toolCalls: [] }
        : { text: `I'm afraid ${why}, and there's nothing free nearby. Is there another day that might work?`, toolCalls: [] };
    }

    // More than one appointment — ask, never guess.
    if (result.requiresDisambiguation === true) {
      const appointments = (result.appointments ?? []) as Array<{ service: string; when: string; with?: string }>;
      const options = appointments.map((a) => `your ${a.service} ${a.when}`).join(', and ');
      const intent = activeIntent(system);

      // Only ask "which one?" when they are about to change one. Somebody
      // asking when they are booked in wants both read out, not a question.
      if (intent === 'cancel' || intent === 'reschedule') {
        return { text: `You've got two booked — ${options}. Which one did you mean?`, toolCalls: [] };
      }
      return {
        text: `You've got ${appointments.length} booked in — ${options}. Anything you'd like to change?`,
        toolCalls: [],
      };
    }

    // Exactly one appointment: act on the caller's stated intent.
    if (result.count === 1 && result.appointment) {
      const appointment = result.appointment as { appointmentId: string; service: string; when: string };
      if (/\bcancel\b/i.test(lastUser) && available.has('propose_cancellation')) {
        return { text: '', toolCalls: [toolCall('propose_cancellation', { appointmentId: appointment.appointmentId })] };
      }
      if (/\b(move|reschedule|change)\b/i.test(lastUser)) {
        return { text: `That's your ${appointment.service} ${appointment.when}. When would you like to move it to?`, toolCalls: [] };
      }
      return { text: `You're booked in for a ${appointment.service} ${appointment.when}.`, toolCalls: [] };
    }

    if (result.count === 0) {
      return { text: "I can't see anything booked under that number. Would you like to make an appointment?", toolCalls: [] };
    }

    // A service has been settled on — move to when.
    if (result.selected === true && typeof result.service === 'string' && result.serviceId) {
      const asked = /\b(how much|price|cost|how long)\b/i.test(lastUser);
      return {
        text: asked
          ? `${result.service} is ${result.price}, and takes about ${result.durationMinutes} minutes. Would you like me to book you in?`
          : `${result.service}, lovely — when were you thinking?`,
        toolCalls: [],
      };
    }

    // The caller's choice has been recorded — carry on with what they wanted.
    if (result.selected === true) {
      const intent = pendingAppointmentIntent(request);
      return intent === 'cancel'
        ? { text: '', toolCalls: [toolCall('propose_cancellation', { appointmentId: String(result.appointmentId) })] }
        : {
            text: `That's your ${result.service} ${result.when}. When would you like to move it to?`,
            toolCalls: [],
          };
    }

    // A staged action — read the restatement back verbatim.
    if (result.staged === true && typeof result.restatement === 'string') {
      return { text: result.restatement, toolCalls: [] };
    }

    // A write came back. Report exactly what happened.
    if (result.success === true) {
      // Phrased from the action that actually ran. Telling someone their
      // cancellation is "booked in" is its own kind of false statement.
      const when = String(result.when ?? '');
      const confirmation =
        result.action === 'cancel'
          ? `That's cancelled for you. Anything else I can help with?`
          : result.action === 'reschedule'
            ? `Lovely — I've moved that to ${when}. Anything else I can help with?`
            : `Lovely — that's booked in for you, ${when}. Anything else I can help with?`;
      return { text: confirmation, toolCalls: [] };
    }
    if (result.success === false) {
      const alternatives = (result.alternatives ?? []) as Array<{ when: string }>;
      return alternatives.length > 0
        ? { text: `I'm sorry — that time has just gone. I could do ${alternatives.map((a) => a.when).join(', or ')}. Would one of those work?`, toolCalls: [] }
        : { text: "I'm sorry — that didn't go through, so nothing has changed. Shall I take your number and have someone call you back?", toolCalls: [] };
    }

    // Information tools — summarise briefly.
    if (Array.isArray(result.services)) {
      const services = result.services as Array<{ name: string; price: string }>;
      // "What else do you have?" gets the ones they have not heard yet.
      const askedForMore = /\b(what else|anything else|else do you|other (services|treatments|options)|more options|full (list|menu)|everything you)\b/i.test(lastUser);
      const remainder = services.slice(SPOKEN_MENU_LIMIT);
      if (askedForMore) {
        return {
          text: remainder.length > 0
            ? `We also do ${remainder.map((x) => `${x.name} at ${x.price}`).join(', ')}. Would you like to book any of those?`
            : `That's everything we offer at the moment. Would you like to book one of them?`,
          toolCalls: [],
        };
      }
      const spoken = services.slice(0, SPOKEN_MENU_LIMIT);
      return {
        text:
          `We do ${spoken.map((s) => `${s.name} at ${s.price}`).join(', ')}` +
          (services.length > spoken.length ? ', and a few others' : '') +
          '. What were you after?',
        toolCalls: [],
      };
    }
    if (Array.isArray(result.openingHours)) {
      const hours = result.openingHours as Array<{ day: string; hours: string }>;
      const policy = result.bookingPolicy as {
        noticeRequired: string; cancellationWindow: string; lateCancellationFee: string; canBookUpTo: string;
      } | undefined;

      // "How much notice do you need to cancel?" is a policy question, and
      // answering it with the opening hours is the kind of near-miss that makes
      // an agent feel like it is not listening.
      if (policy && /\b(cancel|cancellation|notice|fee|charge|policy|refund)\b/i.test(lastUser)) {
        return {
          text:
            `We ask for ${policy.cancellationWindow} notice to cancel` +
            (policy.lateCancellationFee === 'none'
              ? ', and there is no charge if it is later than that.'
              : `, and there's a ${policy.lateCancellationFee} fee inside that.`) +
            ' Was there something you wanted to change?',
          toolCalls: [],
        };
      }
      if (policy && /\b(how (much|far)|notice|advance|ahead)\b/i.test(lastUser)) {
        return {
          text: `We need ${policy.noticeRequired} notice, and you can book up to ${policy.canBookUpTo}. Shall I find you a time?`,
          toolCalls: [],
        };
      }

      // A question about one particular day gets an answer about that day.
      const askedDay = hours.find((h) => new RegExp(`\\b${h.day}s?\\b`, 'i').test(lastUser));
      if (askedDay) {
        return {
          text: askedDay.hours === 'closed'
            ? `We're closed on ${askedDay.day}s, I'm afraid. Can I book you in another day?`
            : `On ${askedDay.day}s we're open ${askedDay.hours}. Can I book you in?`,
          toolCalls: [],
        };
      }

      return { text: `${describeWeek(hours)} Can I book you in?`, toolCalls: [] };
    }
    if (result.known === true && typeof result.firstName === 'string') {
      return { text: `Hello ${result.firstName}! What can I do for you?`, toolCalls: [] };
    }
    if (result.captured === true) {
      return { text: "That's noted — someone will call you back shortly. Sorry again for the trouble.", toolCalls: [] };
    }

    return null;
  }
}

/**
 * What to say when nothing matched.
 *
 * Repeating one generic sentence is what made the agent feel like it had
 * stopped listening. This at least moves the conversation somewhere, and
 * differs depending on what is already known.
 */
function notUnderstood(system: string): LlmTurn {
  if (/ACTIVE_INTENT:reschedule/.test(system)) {
    return { text: "Sorry, I didn't catch that — what day would suit you for the new time?", toolCalls: [] };
  }
  if (/ACTIVE_INTENT:cancel/.test(system)) {
    return { text: "Sorry, I didn't catch that — did you want me to go ahead and cancel it?", toolCalls: [] };
  }
  if (/Service being discussed:/.test(system)) {
    return { text: "Sorry, I didn't quite catch that — what day were you hoping to come in?", toolCalls: [] };
  }
  return {
    text: "Sorry, I didn't quite catch that. I can tell you about our services and prices, book you in, or change an appointment you already have — which would you like?",
    toolCalls: [],
  };
}

/** What the state block says the caller is currently trying to do. */
function activeIntent(system: string): 'book' | 'reschedule' | 'cancel' | undefined {
  const match = /ACTIVE_INTENT:(book|reschedule|cancel)/.exec(system);
  return match ? (match[1] as 'book' | 'reschedule' | 'cancel') : undefined;
}

function lastUserText(request: LlmRequest): string {
  for (let i = request.messages.length - 1; i >= 0; i -= 1) {
    const message = request.messages[i]!;
    if (message.role === 'user') return message.content;
  }
  return '';
}

/** Did the agent's last turn ask for the caller's name and number? */
function awaitingCallbackDetails(request: LlmRequest): boolean {
  for (let i = request.messages.length - 1; i >= 0; i -= 1) {
    const message = request.messages[i]!;
    if (message.role !== 'assistant') continue;
    return /take your name|your name and (the best )?number|call you back|best number/i.test(message.text);
  }
  return false;
}

/** Why they are being called back, taken from their own words. */
function complaintReason(request: LlmRequest): string {
  for (let i = request.messages.length - 1; i >= 0; i -= 1) {
    const message = request.messages[i]!;
    if (message.role !== 'user') continue;
    if (/\b(refund|complain|complaint|ruined|terrible|awful|wrong|unhappy)\b/i.test(message.content)) {
      return message.content.slice(0, 300);
    }
  }
  return 'The receptionist could not complete the caller\u2019s request';
}

interface OfferedService { id: string; name: string; price?: string; durationMinutes?: number }

/** The service menu most recently read to the caller. */
function recentServices(request: LlmRequest): OfferedService[] {
  for (let i = request.messages.length - 1; i >= 0; i -= 1) {
    const message = request.messages[i]!;
    if (message.role !== 'tool_results') continue;
    for (const result of message.results) {
      const content = result.content as { services?: OfferedService[]; slots?: unknown[] };
      // A later availability listing supersedes the menu.
      if (Array.isArray(content.slots)) return [];
      // Only what was read aloud: "the second one" has to mean the second thing
      // the caller heard, not the second row of a longer list.
      if (Array.isArray(content.services) && content.services.length > 0) {
        return content.services.slice(0, SPOKEN_MENU_LIMIT);
      }
    }
  }
  return [];
}

/** Match the caller's words to one of the services offered. */
function pickService(menu: OfferedService[], utterance: string): OfferedService | undefined {
  const text = utterance.toLowerCase();

  const ordinals: Array<[RegExp, number]> = [
    [/\b(first|1st)\b/, 0],
    [/\b(second|2nd)\b/, 1],
    [/\b(third|3rd)\b/, 2],
    [/\b(fourth|4th)\b/, 3],
    [/\b(last|final)\b/, menu.length - 1],
  ];
  for (const [pattern, index] of ordinals) {
    if (pattern.test(text) && menu[index]) return menu[index];
  }

  // By name, most specific first so "cut and blow dry" beats a bare "Blow Dry".
  const scored = menu
    .map((service) => ({ service, ...scoreServiceMatch(service.name, utterance) }))
    .filter((c) => c.hits > 0)
    .sort((a, b) => b.hits - a.hits || b.ratio - a.ratio);
  return scored[0]?.service;
}

interface CandidateAppointment {
  appointmentId: string; service: string; when: string; with?: string; localTime?: string;
}

/**
 * The appointments the caller was last asked to choose between.
 *
 * Scanned backwards from the most recent tool result, because the caller
 * answers "the first one" a turn *after* the list was read to them.
 */
function recentAppointments(request: LlmRequest): CandidateAppointment[] {
  for (let i = request.messages.length - 1; i >= 0; i -= 1) {
    const message = request.messages[i]!;
    if (message.role !== 'tool_results') continue;
    for (const result of message.results) {
      const content = result.content as {
        appointments?: CandidateAppointment[]; selected?: boolean; staged?: boolean;
      };
      // A recorded choice — or a staged proposal naming one appointment — ends
      // the ambiguity. Without this, an older two-appointment listing further
      // back in the history would make the agent re-ask a question the caller
      // has already answered.
      if (content.selected === true || content.staged === true) return [];
      if (Array.isArray(content.appointments) && content.appointments.length > 0) {
        return content.appointments;
      }
    }
  }
  return [];
}

/**
 * Map the caller's answer onto one of the appointments offered.
 *
 * Returns undefined rather than guessing — picking the wrong one cancels a
 * stranger's haircut, so an unmatched answer must produce another question.
 */
function pickAppointment(
  candidates: CandidateAppointment[],
  utterance: string,
): CandidateAppointment | undefined {
  const text = utterance.toLowerCase();

  // "the first one", "the second", "the last one"
  const ordinals: Array<[RegExp, number]> = [
    [/\b(first|1st|earlier|earliest|sooner|soonest)\b/, 0],
    [/\b(second|2nd)\b/, 1],
    [/\b(third|3rd)\b/, 2],
    [/\b(last|latest|later|final)\b/, candidates.length - 1],
  ];
  for (const [pattern, index] of ordinals) {
    if (pattern.test(text) && candidates[index]) return candidates[index];
  }

  // By service name — "the colour", "the root touch up". Most specific wins, so
  // "cut and blow dry" does not match a bare "Blow Dry".
  const byService = candidates
    .map((a) => {
      const words = a.service.toLowerCase().split(/[^a-z]+/).filter((w) => w.length > 2);
      return { a, hits: words.filter((w) => text.includes(w)).length, size: words.length };
    })
    .filter((c) => c.hits > 0)
    .sort((x, y) => y.hits - x.hits || y.size - x.size);
  if (byService[0] && (!byService[1] || byService[0].hits > byService[1].hits)) return byService[0].a;

  // By time — "the 10:30 one". Matched on the appointment's salon-local time,
  // the same way slots are, rather than by fishing substrings out of a label.
  const wanted = spokenTimeToLocal(text);
  if (wanted.length > 0) {
    const match = candidates.find((a) => a.localTime && wanted.includes(a.localTime));
    if (match) return match;
  }
  const day = /\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday|today|tomorrow)\b/.exec(text);
  if (day) {
    const matches = candidates.filter((a) => a.when.toLowerCase().includes(day[1]!));
    if (matches.length === 1) return matches[0];
  }

  return undefined;
}

/**
 * What the caller wanted to do before being asked which appointment.
 *
 * Read from their own earlier words rather than from conversation state,
 * because the intent was stated a turn or two before the choice was made.
 */
function pendingAppointmentIntent(request: LlmRequest): 'cancel' | 'reschedule' | undefined {
  for (let i = request.messages.length - 1; i >= 0; i -= 1) {
    const message = request.messages[i]!;
    if (message.role !== 'user') continue;
    if (/\b(cancel|can'?t make|not going to make)\b/i.test(message.content)) return 'cancel';
    if (/\b(move|reschedule|rearrange|change.*(appointment|time)|different time|push.*back)\b/i.test(message.content)) {
      return 'reschedule';
    }
  }
  return undefined;
}

/** The appointment the state block says is already settled, if any. */
function settledAppointmentId(system: string): string | undefined {
  return (
    /The appointment they are talking about is id ([\w-]+)\./.exec(system)?.[1] ??
    /They have one appointment: .*? — id ([\w-]+)\./.exec(system)?.[1]
  );
}

/** The service of that settled appointment, so a reschedule can search for slots. */
function settledServiceId(system: string): string | undefined {
  const name =
    /They have one appointment: (.+?),/.exec(system)?.[1] ??
    /Service being discussed: (.+?)\./.exec(system)?.[1];
  if (!name) return undefined;
  const match = /SERVICE_IDS:(\{.*?\})/s.exec(system);
  if (!match) return undefined;
  try {
    return (JSON.parse(match[1]!) as Record<string, string>)[name];
  } catch {
    return undefined;
  }
}

interface OfferedSlot { start: string; when: string; staffId: string; localTime?: string }

/**
 * The most recent set of times offered to the caller.
 *
 * Scans backwards through the exchange rather than relying on the immediately
 * previous message: the caller answers "the first one" a turn *after* the
 * availability result arrived.
 */
function recentSlots(request: LlmRequest): OfferedSlot[] {
  for (let i = request.messages.length - 1; i >= 0; i -= 1) {
    const message = request.messages[i]!;
    if (message.role !== 'tool_results') continue;
    for (const result of message.results) {
      const content = result.content as {
        slots?: OfferedSlot[]; alternatives?: OfferedSlot[]; success?: boolean;
      };
      // A completed write consumes the offer. Otherwise a stray "yes" after
      // "that's booked in" re-proposes the slot list all over again.
      if (content.success === true) return [];
      const slots = content.slots ?? content.alternatives;
      // Only the times that were actually read out. "The third one" has to mean
      // the third thing the caller heard, and a time they were never offered
      // should not be bookable by accident.
      if (Array.isArray(slots) && slots.length > 0) return slots.slice(0, SPOKEN_SLOT_LIMIT);
    }
  }
  return [];
}

/**
 * Say the opening hours the way a person would.
 *
 * Runs of days that share the same hours are collapsed ("Tuesday to Friday"),
 * and days that differ are named separately. The previous version announced the
 * first open day, the last open day and the *first day's* hours — which for a
 * salon whose hours vary read as "open Sunday to Saturday, 11:00-17:00" when it
 * was actually open until 9pm on Thursdays. Wrong opening hours are the kind of
 * thing a caller turns up on the strength of.
 */
function describeWeek(hours: Array<{ day: string; hours: string }>): string {
  // Monday-first: the week as people describe it, not as Date#getDay numbers it.
  const ordered = [...hours.slice(1), hours[0]!];
  const open = ordered.filter((h) => h.hours !== 'closed');
  if (open.length === 0) return "We're closed all week at the moment.";

  const runs: Array<{ from: string; to: string; hours: string; lastIndex: number }> = [];
  ordered.forEach((day, index) => {
    if (day.hours === 'closed') return;
    const last = runs.at(-1);
    // Adjacency is measured on the calendar, not on the list of open days:
    // Monday and Wednesday may share hours, but with Tuesday closed between
    // them "Monday to Wednesday" is not true.
    if (last && last.hours === day.hours && last.lastIndex === index - 1) {
      last.to = day.day;
      last.lastIndex = index;
    } else {
      runs.push({ from: day.day, to: day.day, hours: day.hours, lastIndex: index });
    }
  });

  const spoken = runs.map((r) => (r.from === r.to ? `${r.from} ${r.hours}` : `${r.from} to ${r.to} ${r.hours}`));
  const closed = ordered.filter((h) => h.hours === 'closed').map((h) => `${h.day}s`);

  return (
    `We're open ${spoken.join(', ')}` +
    (closed.length > 0 ? `, and closed ${closed.join(' and ')}` : '') +
    '.'
  );
}

/** The day the offered slots are on, taken from their spoken labels. */
function dayOfOffer(slots: OfferedSlot[]): string | undefined {
  const label = slots[0]?.when ?? '';
  return /\b(today|tomorrow|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i.exec(label)?.[1];
}

/** Minutes since midnight, for comparing local clock times. */
function minutesOf(local: string): number {
  const [h, m] = local.split(':').map(Number);
  return h! * 60 + m!;
}

/**
 * Of the possible readings of what the caller said, the one nearest the times
 * already under discussion. Context disambiguates "half two" far better than
 * any rule about mornings and afternoons.
 */
function nearestReading(readings: string[], offered: OfferedSlot[]): string {
  const anchor = offered.find((o) => o.localTime)?.localTime;
  if (!anchor || readings.length === 1) return readings[0]!;
  return readings.reduce((best, candidate) =>
    Math.abs(minutesOf(candidate) - minutesOf(anchor)) < Math.abs(minutesOf(best) - minutesOf(anchor))
      ? candidate
      : best,
  );
}

/** "14:30" -> "2:30pm", so the deterministic resolver can read it back. */
function speakLocalTime(local: string): string {
  const [h, m] = local.split(':').map(Number);
  const hour = h! % 12 === 0 ? 12 : h! % 12;
  const suffix = h! < 12 ? 'am' : 'pm';
  return m === 0 ? `${hour}${suffix}` : `${hour}:${String(m).padStart(2, '0')}${suffix}`;
}

/** Match the caller's words to one of the offered times. */
function pickSlot(slots: OfferedSlot[], utterance: string): OfferedSlot | undefined {
  // "9:30 a.m." and "9:30am" are the same request.
  const text = utterance
    .toLowerCase()
    .replace(/\ba\.\s?m\.?/g, 'am')
    .replace(/\bp\.\s?m\.?/g, 'pm');

  const ordinals: Array<[RegExp, number]> = [
    [/\b(first|1st|earliest|earlier one)\b/, 0],
    [/\b(second|2nd)\b/, 1],
    [/\b(third|3rd)\b/, 2],
    [/\b(last|latest)\b/, slots.length - 1],
  ];
  for (const [pattern, index] of ordinals) {
    if (pattern.test(text) && slots[index]) return slots[index];
  }

  const wanted = spokenTimeToLocal(text);
  if (wanted.length > 0) {
    // Matched against the slot's salon-local time — never against `start`,
    // which is a UTC instant. Under BST the 10:30 slot's instant is T09:30, so
    // comparing a caller's "9:30" to it books them an hour late.
    const match = slots.find((s) => s.localTime && wanted.includes(s.localTime));
    if (match) return match;

    // The caller named a time we did not offer. Say so rather than booking the
    // nearest thing and hoping they do not notice.
    return undefined;
  }

  // A plain acceptance takes the first thing offered — what "yes please" means
  // after being read a list.
  if (/\b(yes|yeah|sure|please|that one|sounds good|perfect|ok|okay|go on)\b/i.test(text)) return slots[0];
  return undefined;
}

/**
 * The salon-local 24-hour times a spoken phrase could mean.
 *
 * Returns both readings of a bare hour ("half nine" is 09:30 or 21:30) and lets
 * the caller decide by which one was actually offered.
 */
function spokenTimeToLocal(text: string): string[] {
  const pad = (n: number) => String(n).padStart(2, '0');
  const readings = (hour: number, minute: number, meridiem?: string): string[] => {
    if (meridiem === 'am') return [`${pad(hour === 12 ? 0 : hour)}:${pad(minute)}`];
    if (meridiem === 'pm') return [`${pad(hour === 12 ? 12 : hour + 12)}:${pad(minute)}`];
    if (hour > 12) return [`${pad(hour)}:${pad(minute)}`];
    return [`${pad(hour)}:${pad(minute)}`, `${pad((hour % 12) + 12)}:${pad(minute)}`];
  };

  // People say "half past nine" as often as "9:30".
  const HOUR_WORDS: Record<string, number> = {
    one: 1, two: 2, three: 3, four: 4, five: 5, six: 6,
    seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
  };
  const NUM = `(\\d{1,2}|${Object.keys(HOUR_WORDS).join('|')})`;
  const hourOf = (token: string) => HOUR_WORDS[token] ?? Number(token);

  let m = /\b(\d{1,2})[:.](\d{2})\s*(am|pm)?/.exec(text);
  if (m) return readings(Number(m[1]), Number(m[2]), m[3]);

  m = new RegExp(`\\bhalf past ${NUM}\\s*(am|pm)?`).exec(text)
    ?? new RegExp(`\\bhalf ${NUM}\\s*(am|pm)?`).exec(text);
  if (m) return readings(hourOf(m[1]!), 30, m[2]);

  m = new RegExp(`\\bquarter past ${NUM}\\s*(am|pm)?`).exec(text);
  if (m) return readings(hourOf(m[1]!), 15, m[2]);

  m = new RegExp(`\\bquarter to ${NUM}\\s*(am|pm)?`).exec(text);
  if (m) {
    const hour = hourOf(m[1]!);
    return readings(hour === 1 ? 12 : hour - 1, 45, m[2]);
  }

  m = new RegExp(`\\b${NUM}\\s*(am|pm)\\b`).exec(text);
  if (m) return readings(hourOf(m[1]!), 0, m[2]);

  if (/\b(noon|midday)\b/.test(text)) return ['12:00'];

  m = new RegExp(`\\b${NUM}\\s*o'?clock\\b`).exec(text);
  if (m) return readings(hourOf(m[1]!), 0);

  return [];
}

function discussedServiceId(system: string): string | undefined {
  const discussed = /Service being discussed: (.+?)\./.exec(system)?.[1];
  if (!discussed) return undefined;
  const match = /SERVICE_IDS:(\{.*?\})/s.exec(system);
  if (!match) return undefined;
  try {
    return (JSON.parse(match[1]!) as Record<string, string>)[discussed];
  } catch {
    return undefined;
  }
}

function lastToolResult(request: LlmRequest): Record<string, unknown> | null {
  const last = request.messages.at(-1);
  if (!last || last.role !== 'tool_results') return null;
  const first = last.results[0];
  return first ? (first.content as Record<string, unknown>) : null;
}

/** Words that carry no signal about which service is meant. */
const SERVICE_STOPWORDS = new Set(['and', 'the', 'with', 'for', 'full', 'head']);

function words(text: string): string[] {
  return text.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(Boolean);
}

/**
 * How well an utterance names a service.
 *
 * Matched on whole words, not substrings. Substring matching produced a real
 * and very confusing bug: "I would like to book an appointment" silently
 * resolved to "Men's Cut", because "appoint-men-t" contains "men". The agent
 * then asked when they wanted their men's cut, and every later turn disagreed
 * with itself.
 *
 * Prefix-tolerant in both directions so "mens cut" still finds "Men's Cut".
 */
function scoreServiceMatch(name: string, utterance: string): { hits: number; ratio: number } {
  const target = words(name).filter((w) => w.length > 2 && !SERVICE_STOPWORDS.has(w));
  if (target.length === 0) return { hits: 0, ratio: 0 };
  const said = words(utterance);

  // Exact, or a simple plural, or a long shared prefix. Loose prefix matching
  // was not tolerant, it was wrong: "like **to** book" prefix-matched
  // "**To**uch-Up" and the agent decided the caller wanted a root touch-up.
  const matches = (target_: string, said_: string): boolean =>
    said_ === target_ ||
    said_ === `${target_}s` ||
    target_ === `${said_}s` ||
    (target_.length >= 5 && said_.length >= 5 && (said_.startsWith(target_) || target_.startsWith(said_)));

  const hits = target.filter((w) => said.some((x) => matches(w, x))).length;

  return { hits, ratio: hits / target.length };
}

function serviceCatalogue(system: string): Record<string, string> | undefined {
  const match = /SERVICE_IDS:(\{.*?\})/s.exec(system);
  if (!match) return undefined;
  try {
    return JSON.parse(match[1]!) as Record<string, string>;
  } catch {
    return undefined;
  }
}

/** The service named outright in an utterance, if any. Most specific wins. */
function serviceNamedIn(system: string, utterance: string): { id: string; name: string } | undefined {
  const catalogue = serviceCatalogue(system);
  if (!catalogue) return undefined;

  const scored = Object.entries(catalogue)
    .map(([name, id]) => ({ id, name, ...scoreServiceMatch(name, utterance) }))
    .filter((c) => c.hits > 0)
    // "cut and blow dry" must beat both "Blow Dry" and "Men's Cut".
    .sort((a, b) => b.hits - a.hits || b.ratio - a.ratio);

  return scored[0] ? { id: scored[0].id, name: scored[0].name } : undefined;
}

/** A service named outright, or otherwise the one already under discussion. */
function serviceIdFor(system: string, utterance: string): string | undefined {
  const named = serviceNamedIn(system, utterance);
  if (named) return named.id;

  const catalogue = serviceCatalogue(system);
  const discussed = /Service being discussed: (.+)\./.exec(system)?.[1];
  return discussed && catalogue ? catalogue[discussed] : undefined;
}

/** Extract the caller's time phrase and hand it to the deterministic resolver. */
function timePhrase(utterance: string): string | undefined {
  const patterns = [
    /\b(?:next|this|coming)?\s*(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b[^.?!]*/i,
    /\b(?:tomorrow|today|tonight)\b[^.?!]*/i,
    /\b(?:next week|this week|next month|the weekend|weekend)\b[^.?!]*/i,
    /\bin \d+ (?:days?|weeks?)\b/i,
    /\ba week (?:from|after) \w+/i,
    /\b(?:after|before|around|at) \d{1,2}(?::\d{2})?\s*(?:am|pm)?\b/i,
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(utterance);
    if (match) return match[0].trim();
  }
  return undefined;
}

/**
 * Internals exposed for tests. `spokenTimeToLocal` is the piece that turns what
 * a caller says into a salon-local clock time, and getting it wrong books
 * people at the wrong hour, so it is worth testing directly rather than only
 * through a conversation.
 */
export const __testing = { spokenTimeToLocal, pickSlot, pickAppointment, scoreServiceMatch, describeWeek };
