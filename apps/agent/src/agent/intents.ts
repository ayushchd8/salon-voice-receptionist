/**
 * What the caller is asking for, in their own words.
 *
 * These patterns are defined here once because they were previously duplicated
 * between the orchestrator (which tags the call record) and the dialogue policy
 * (which decides what to do). The two copies drifted — "swap my appointment"
 * counted as a reschedule in one and a booking in the other — so a caller could
 * be routed one way and recorded another.
 */
import type { CallIntent } from '@salon/contracts';

export const RESCHEDULE_PHRASES =
  /\b(reschedule|rearrange|swap|shift|move|push (it |that )?back|put (it |that )?back|change (my|the|that) (appointment|booking|time)|different time|another time|other time)\b/i;

export const CANCEL_PHRASES =
  /\b(cancel|cancelling|canceling|can'?t make it|cannot make it|not going to make it|won'?t make it|call it off)\b/i;

export const BOOK_PHRASES =
  /\b(book|booking|appointment|come in|slot|available|availability|free|fit me in|squeeze me in|get me in|any chance|do you have anything|make an appointment)\b/i;

export const LOOKUP_PHRASES =
  /\b(when (is|am i)|what time is my|do i have|am i booked|when'?s my)\b/i;

/**
 * The single action being asked for, if the caller said so plainly.
 *
 * Order matters: "change my appointment" contains "appointment", so the
 * reschedule and cancel checks must come before the booking one.
 */
export function statedIntent(utterance: string): 'book' | 'reschedule' | 'cancel' | undefined {
  if (RESCHEDULE_PHRASES.test(utterance)) return 'reschedule';
  if (CANCEL_PHRASES.test(utterance)) return 'cancel';
  if (BOOK_PHRASES.test(utterance)) return 'book';
  return undefined;
}

/**
 * Keyword intent tagging for the call record.
 *
 * Never used to route the conversation — it only makes sure a call that ends
 * before any tool runs is still filed under something a supervisor can search.
 */
const INTENT_PATTERNS: Array<[CallIntent, RegExp]> = [
  ['complaint', /\b(refund|money back|complain|complaint|terrible|awful|ruined|furious|disgusted|unhappy with)\b/i],
  ['cancellation', CANCEL_PHRASES],
  ['reschedule', RESCHEDULE_PHRASES],
  ['booking', BOOK_PHRASES],
  ['availability', /\b(available|availability|free|any slots|got anything|do you have)\b/i],
  ['pricing', /\b(how much|price|cost|charge|expensive)\b/i],
  ['hours', /\b(open|opening|close|closing|what time are you|hours)\b/i],
  ['services', /\b(what do you (do|offer)|services|menu|treatments)\b/i],
  ['policy', /\b(policy|notice|deposit|cancellation fee)\b/i],
  ['lookup', LOOKUP_PHRASES],
  ['callback', /\b(call me back|speak to|manager|human|real person)\b/i],
  ['out_of_scope', /\b(refund|invoice|vat|receipt|job|vacancy|complaint)\b/i],
];

export function detectIntents(utterance: string): CallIntent[] {
  return INTENT_PATTERNS.filter(([, pattern]) => pattern.test(utterance)).map(([intent]) => intent);
}
