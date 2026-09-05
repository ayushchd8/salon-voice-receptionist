import { describe, expect, it } from 'vitest';
import { classifyConfirmation } from './confirmation.js';

describe('classifying the answer to "shall I go ahead?"', () => {
  it.each([
    'yes', 'yes please', 'yeah go on', 'yep', 'go ahead', 'do it',
    "that's right", 'sounds good', 'perfect', 'lovely, thanks', 'confirm that',
  ])('treats %j as agreement', (utterance) => {
    expect(classifyConfirmation(utterance)).toBe('affirmative');
  });

  it.each([
    'no',
    'no thanks',
    "actually no, I want to move it instead",
    'actually can we do Friday',
    'wait, the other one',
    'hold on',
    'sorry, I meant the colour',
    'change it to Thursday',
    'not that one',
  ])('treats %j as a correction', (utterance) => {
    expect(classifyConfirmation(utterance)).toBe('correction');
  });

  it('treats a yes carrying a correction as a correction', () => {
    // The dangerous case: an affirmative word inside a sentence that changes
    // the plan. Committing here books or cancels the wrong thing.
    for (const utterance of [
      'yes but can we make it Friday instead',
      'yeah, actually the other one',
      "ok but not that time",
    ]) {
      expect(classifyConfirmation(utterance)).toBe('correction');
    }
  });

  it.each(['how much was that again?', 'next Thursday afternoon', 'the second one', ''])(
    'treats %j as unclear rather than agreement',
    (utterance) => {
      expect(classifyConfirmation(utterance)).not.toBe('affirmative');
    },
  );
});
