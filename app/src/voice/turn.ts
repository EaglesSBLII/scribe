/**
 * When has the writer finished what they were saying to the counselor?
 *
 * A pause for breath is not the end of an idea. What is said to the counselor
 * is collected until the writer has been quiet for a while, and how long
 * depends on how the words so far end.
 */

/** A direct question is finished when it is asked. */
export const AFTER_QUESTION_MS = 700;
/** A finished sentence: wait in case another follows. */
export const AFTER_SENTENCE_MS = 2000;
/** Trailing off ("and...", "because", "um") means more is coming. */
export const AFTER_TRAILING_MS = 3500;

const TRAILING = /\b(and|but|so|or|because|cause|then|also|um|uh|er|hmm|you know|i mean|i guess|kind of|sort of)[\s,.…-]*$/i;

/** How long to stay quiet after `text` before taking it as a finished turn. */
export function turnPause(text: string): number {
  const said = text.trim();
  if (TRAILING.test(said) || !/[.!?]["”')\]]*$/.test(said) || /(\.\.\.|…)$/.test(said)) return AFTER_TRAILING_MS;
  return said.endsWith('?') ? AFTER_QUESTION_MS : AFTER_SENTENCE_MS;
}
