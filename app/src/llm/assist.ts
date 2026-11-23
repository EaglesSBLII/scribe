/**
 * Small jobs where a small, fast local model gives a label or a structured
 * request, never essay text. Every answer is checked in code before anything
 * happens, and none of these functions can touch an essay.
 *
 *  - readRequest: a spoken edit request in free wording -> {op, target, args}
 *  - classifySpokenWord: was "period" a command or a word?
 *  - findSentence: which sentence is "the one about the boat"?
 */
import { platform } from '../platform';
import { useSettings } from '../settings';

/** A spoken request as structured data. Numbers are 1-based; 0 means "not said", -1 means "the last one". */
export interface RequestJson {
  op: 'insert' | 'delete' | 'move' | 'replace' | 'undo' | 'redo' | 'read' | 'count' | 'goto' | 'mode' | 'none';
  target: { unit: 'utterance' | 'words' | 'sentence' | 'paragraph' | 'essay' | 'none'; paragraph: number; sentence: number; to_sentence: number; count: number };
  args: {
    place: 'after' | 'before' | 'start' | 'end' | 'above' | 'below' | 'up' | 'down' | 'top' | 'bottom' | 'none';
    other_paragraph: number;
    text: string;
    find: string;
    with: string;
    what: 'total' | 'left' | 'paragraph' | 'none';
  };
}

const REQUEST_SCHEMA = {
  type: 'object',
  required: ['op', 'target', 'args'],
  properties: {
    op: { type: 'string', enum: ['insert', 'delete', 'move', 'replace', 'undo', 'redo', 'read', 'count', 'goto', 'mode', 'none'] },
    target: {
      type: 'object',
      required: ['unit', 'paragraph', 'sentence', 'to_sentence', 'count'],
      properties: {
        unit: { type: 'string', enum: ['utterance', 'words', 'sentence', 'paragraph', 'essay', 'none'] },
        paragraph: { type: 'integer' },
        sentence: { type: 'integer' },
        to_sentence: { type: 'integer' },
        count: { type: 'integer' },
      },
    },
    args: {
      type: 'object',
      required: ['place', 'other_paragraph', 'text', 'find', 'with', 'what'],
      properties: {
        place: { type: 'string', enum: ['after', 'before', 'start', 'end', 'above', 'below', 'up', 'down', 'top', 'bottom', 'none'] },
        other_paragraph: { type: 'integer' },
        text: { type: 'string' },
        find: { type: 'string' },
        with: { type: 'string' },
        what: { type: 'string', enum: ['total', 'left', 'paragraph', 'none'] },
      },
    },
  },
};

const REQUEST_RULES = `A student is dictating an essay and has spoken a request to the app. Turn it into JSON: {"op", "target", "args"}. You never write or change essay text yourself.

op: insert, delete, move, replace, undo, redo, read (read aloud), count (word count), goto (go to a sentence by its topic), mode (draft, coach or conversation mode), or none if it is not one of these (for example a question about the essay).
target.unit: utterance ("what I just said"), words, sentence, paragraph, essay, or none.
target.paragraph, target.sentence: the number said; 0 if none was said; -1 for "the last". target.to_sentence: the end of a range of sentences, else 0. target.count: how many words, else 0.
args.place: after or before (a sentence), start or end (of a paragraph), above/below (another paragraph), up/down, top/bottom, else none. args.other_paragraph: the other paragraph for a move, else 0.
args.text: for insert, the student's exact words to insert, copied word for word; for goto, the topic; for mode, the mode name; else "".
args.find and args.with: for replace, copied exactly; else "".
args.what: for count: total, left (words left for the limit), or paragraph; else none.

Examples:
"take out the second sentence" -> {"op":"delete","target":{"unit":"sentence","paragraph":0,"sentence":2,"to_sentence":0,"count":0},"args":{"place":"none","other_paragraph":0,"text":"","find":"","with":"","what":"none"}}
"get rid of what I just said" -> {"op":"delete","target":{"unit":"utterance","paragraph":0,"sentence":0,"to_sentence":0,"count":0},"args":{"place":"none","other_paragraph":0,"text":"","find":"","with":"","what":"none"}}
"lose the last three words" -> {"op":"delete","target":{"unit":"words","paragraph":0,"sentence":0,"to_sentence":0,"count":3},"args":{"place":"none","other_paragraph":0,"text":"","find":"","with":"","what":"none"}}
"swap the word happy for relieved in paragraph one" -> {"op":"replace","target":{"unit":"paragraph","paragraph":1,"sentence":0,"to_sentence":0,"count":0},"args":{"place":"none","other_paragraph":0,"text":"","find":"happy","with":"relieved","what":"none"}}
"put paragraph four on top of paragraph two" -> {"op":"move","target":{"unit":"paragraph","paragraph":4,"sentence":0,"to_sentence":0,"count":0},"args":{"place":"above","other_paragraph":2,"text":"","find":"","with":"","what":"none"}}
"take me to the bit about my grandfather" -> {"op":"goto","target":{"unit":"sentence","paragraph":0,"sentence":0,"to_sentence":0,"count":0},"args":{"place":"none","other_paragraph":0,"text":"my grandfather","find":"","with":"","what":"none"}}
"is my opening too slow" -> {"op":"none","target":{"unit":"none","paragraph":0,"sentence":0,"to_sentence":0,"count":0},"args":{"place":"none","other_paragraph":0,"text":"","find":"","with":"","what":"none"}}`;

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

async function ask<T>(system: string, user: string, format: unknown, limit: number): Promise<T | null> {
  try {
    const raw = await platform.llmChat({
      model: useSettings.getState().commandModel || useSettings.getState().llmModel,      options: { temperature: 0, seed: 7, num_predict: limit },
      format,
      messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
    });
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

/** A spoken request in free wording, as structured data. null when the model is unavailable. */
export async function readRequest(utterance: string): Promise<RequestJson | null> {
  const json = await ask<RequestJson>(REQUEST_RULES, utterance, REQUEST_SCHEMA, 220);
  return json && typeof json === 'object' && json.target && json.args ? json : null;
}

/** Was this word a spoken punctuation command, or a word in the sentence? null if unknown. */
export async function classifySpokenWord(utterance: string, word: string): Promise<'command' | 'word' | null> {
  const json = await ask<{ reading?: unknown }>(
    'A student is dictating an essay aloud. Sometimes they say the name of a punctuation mark to insert it ("I love boats period"), and sometimes the same word is simply part of the sentence ("the Jurassic period was huge"). Decide which it was. Answer in JSON as {"reading": "command"} or {"reading": "word"}.',
    `Dictated: "${utterance}"\nThe word in question: "${word}"`,
    { type: 'object', required: ['reading'], properties: { reading: { type: 'string', enum: ['command', 'word'] } } },
    30,
  );
  return json?.reading === 'command' || json?.reading === 'word' ? json.reading : null;
}

/**
 * Which sentence of the essay is about this topic? `numbered` is the essay
 * with one labelled sentence per line. Returns a label like "P2·S3", or null.
 * The model only points; Scribe reads the sentence back and asks before moving.
 */
export async function findSentence(topic: string, numbered: string): Promise<string | null> {
  const json = await ask<{ label?: unknown }>(
    'Here is an essay with one labelled sentence per line. The student wants to go to the sentence about a topic. Answer in JSON as {"label": "P2·S3"} with the label of the ONE sentence that best matches the topic, or {"label": "none"} if no sentence is about it. Do not write anything else.',
    `ESSAY\n${numbered}\n\nTOPIC: ${topic}`,
    { type: 'object', required: ['label'], properties: { label: { type: 'string' } } },
    30,
  );
  const label = typeof json?.label === 'string' ? json.label.trim() : '';
  return /^P\d+·S\d+$/.test(label) ? label : null;
}
