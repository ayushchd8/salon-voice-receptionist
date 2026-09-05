/**
 * Classifying the caller's answer to "shall I go ahead?".
 *
 * This is the gate between a staged action and a real one, so it is
 * deliberately biased: anything that is not a clear, unqualified yes counts as
 * not-a-yes, and the staged action is thrown away.
 *
 * The asymmetry is the point. Re-proposing costs the caller one extra sentence.
 * Committing something they did not agree to cancels the wrong appointment.
 */

/**
 * Words that mean the plan just changed — checked *before* the affirmative
 * patterns, because "yes, actually can we make it Friday" contains a yes and
 * must still not commit anything.
 */
const CORRECTION =
  /\b(no|nope|nah|not|don'?t|do not|actually|instead|rather|wait|hold on|hang on|sorry|change|different|another|other one|scrap|forget|cancel that|never mind|nevermind|but)\b/i;

/** An unqualified acceptance. */
const AFFIRMATIVE =
  /\b(yes|yeah|yep|yup|yah|sure|please|ok|okay|okey|go ahead|go for it|do it|book it|confirm|confirmed|that'?s right|that'?s correct|correct|sounds good|sounds great|sounds lovely|perfect|lovely|great|brilliant|wonderful|absolutely|definitely|certainly|of course|fine|deal)\b/i;

export type ConfirmationVerdict = 'affirmative' | 'correction' | 'unclear';

/**
 * `affirmative` — commit. `correction` — the caller changed something.
 * `unclear` — they said something else entirely (a question, a new topic).
 *
 * Only `affirmative` keeps a staged action alive.
 */
export function classifyConfirmation(utterance: string): ConfirmationVerdict {
  const text = utterance.trim();
  if (!text) return 'unclear';

  // Checked first: a sentence containing both a yes and a correction is a
  // correction. "Yes, but can we do Friday instead" must not book Thursday.
  if (CORRECTION.test(text)) return 'correction';
  if (AFFIRMATIVE.test(text)) return 'affirmative';
  return 'unclear';
}

export function isAffirmation(utterance: string): boolean {
  return classifyConfirmation(utterance) === 'affirmative';
}
