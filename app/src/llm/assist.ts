/**
 * Two small jobs where the model gives a label, never essay text:
 *  - restating an unusual spoken edit request in the fixed command grammar;
 *  - a second opinion on a word that might have been a spoken command.
 * Both answers are checked in code before anything happens.
 */
import { platform } from '../platform';
import { useSettings } from '../settings';

const COMMAND_FORMS = `insert <the student's exact words> after sentence N in paragraph P
insert <the student's exact words> before sentence N in paragraph P
insert <the student's exact words> at the start of paragraph P
insert <the student's exact words> at the end of paragraph P
delete sentence N in paragraph P
delete the last sentence
delete sentences N through M in paragraph P
delete paragraph P
move paragraph P above paragraph Q
move paragraph P below paragraph Q
replace <old words> with <new words> in paragraph P
read back paragraph P
read back sentence N in paragraph P
how many words in paragraph P
word count
none`;

const EDIT_VERBS = new Set([
  'insert', 'add', 'put', 'delete', 'remove', 'erase', 'cut', 'take', 'get', 'drop', 'lose', 'move', 'swap', 'switch',
  'shift', 'replace', 'change', 'read', 'count', 'can', 'could', 'please', 'scribe',
]);

/** Cheap test for "this might be an edit request", so ordinary dictation never waits on the model. */
export function looksLikeEditRequest(text: string): boolean {
  const words = text.toLowerCase().match(/[\p{L}\p{N}']+/gu) ?? [];
  if (words.length < 3 || words.length > 30 || !EDIT_VERBS.has(words[0] ?? '')) return false;
  return words.some((w) => /^(sentences?|paragraphs?)$/.test(w));
}

/**
 * Ask the model to restate an edit request as one line of the command grammar.
 * Returns that line, or null when it is not an edit request or the model is unavailable.
 */
export async function restateCommand(utterance: string): Promise<string | null> {
  try {
    const raw = await platform.llmChat({
      model: useSettings.getState().llmModel,
      options: { temperature: 0, seed: 7, num_predict: 120 },
      format: { type: 'object', required: ['command'], properties: { command: { type: 'string' } } },
      messages: [
        {
          role: 'system',
          content: `A student is dictating an essay and may have spoken an editing request. Restate it as exactly one of these forms, using digits for numbers. Leave out "in paragraph P" if they did not name a paragraph. Copy any words to insert or replace exactly as the student said them. If it is not an editing request, or you are unsure, answer "none". Answer in JSON as {"command": "..."}.\n\nForms:\n${COMMAND_FORMS}`,
        },
        { role: 'user', content: utterance },
      ],
    });
    const command = (JSON.parse(raw) as { command?: unknown }).command;
    return typeof command === 'string' && command.trim().toLowerCase() !== 'none' ? command.trim() : null;
  } catch {
    return null;
  }
}

/** Was this word a spoken punctuation command, or a word in the sentence? null if unknown. */
export async function classifySpokenWord(utterance: string, word: string): Promise<'command' | 'word' | null> {
  try {
    const raw = await platform.llmChat({
      model: useSettings.getState().llmModel,
      options: { temperature: 0, seed: 7, num_predict: 30 },
      format: { type: 'object', required: ['reading'], properties: { reading: { type: 'string', enum: ['command', 'word'] } } },
      messages: [
        {
          role: 'system',
          content:
            'A student is dictating an essay aloud. Sometimes they say the name of a punctuation mark to insert it ("I love boats period"), and sometimes the same word is simply part of the sentence ("the Jurassic period was huge"). Decide which it was. Answer in JSON as {"reading": "command"} or {"reading": "word"}.',
        },
        { role: 'user', content: `Dictated: "${utterance}"\nThe word in question: "${word}"` },
      ],
    });
    const reading = (JSON.parse(raw) as { reading?: unknown }).reading;
    return reading === 'command' || reading === 'word' ? reading : null;
  } catch {
    return null;
  }
}
