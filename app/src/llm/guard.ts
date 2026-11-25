/**
 * Checks on what the model says, done in code. The model is told not to draft
 * essay text; these checks catch it when it does anyway.
 */

const norm = (s: string) => s.toLowerCase().replace(/[’‘]/g, "'").replace(/[“”]/g, '"').replace(/\s+/g, ' ').trim();
const wordCount = (s: string) => (s.match(/[\p{L}\p{N}]+/gu) ?? []).length;

const WRITE = '(write|rewrite|draft|compose|generate|redo|reword|rephrase|fix up|polish|finish|continue)';
const PIECE = '(essay|paragraph|paragraphs|intro|introduction|opening|conclusion|ending|sentence|sentences|hook|it|this|that)';
const WRITE_REQUESTS = [
  // "can you write ...", "write me ...", "... write it for me"
  new RegExp(`\\b(can|could|would|will) you (please |just |maybe )*${WRITE}\\b`),
  new RegExp(`\\b${WRITE} me\\b`),
  new RegExp(`\\b${WRITE}\\b.{0,60}\\bfor me\\b`),
  // An instruction: the sentence begins with the verb ("just draft the conclusion").
  new RegExp(`(^|[.!?] )(please |just |now |okay |ok |and |then |jarvis,? )*${WRITE}\\b.{0,60}\\b${PIECE}\\b`),
  /\bgive me (a|an|the) (paragraph|intro|introduction|opening|conclusion|draft|essay)\b/,
];

/**
 * Did the student ask the counselor to write for them? Talking about their own
 * writing ("I want to write about that summer") is not a request.
 */
export function asksForWriting(message: string): boolean {
  const m = norm(message);
  return WRITE_REQUESTS.some((re) => re.test(m));
}

/**
 * Does this reply say again, word for word, a sentence the counselor has
 * already said? Short stock phrases ("Go on.") do not count.
 */
export function repeatsItself(reply: string, earlier: string[]): boolean {
  const sentences = (text: string) =>
    norm(text.replace(/\[interrupted\]/g, ''))
      .split(/(?<=[.!?])\s+/)
      .map((s) => s.replace(/[^\p{L}\p{N}\s']/gu, '').replace(/\s+/g, ' ').trim())
      .filter((s) => wordCount(s) >= 5);
  const before = new Set(earlier.flatMap(sentences));
  return before.size > 0 && sentences(reply).some((s) => before.has(s));
}

export interface QuotedSpan {
  text: string;
  /** True when these exact words are in the essay (or in what the student said). */
  yours: boolean;
}

/** Split a reply into plain text and quoted spans, marking which quotes are the student's own words. */
export function splitQuotes(reply: string, studentText: string): (string | QuotedSpan)[] {
  const source = norm(studentText);
  const out: (string | QuotedSpan)[] = [];
  const re = /“([^”]{2,})”|"([^"]{2,})"/g;
  let last = 0;
  for (const m of reply.matchAll(re)) {
    if (m.index > last) out.push(reply.slice(last, m.index));
    const text = m[1] ?? m[2];
    const core = norm(text).replace(/^[\s.,;:!?…]+|[\s.,;:!?…]+$/g, '');
    out.push({ text, yours: core.length > 0 && source.includes(core) });
    last = m.index + m[0].length;
  }
  if (last < reply.length) out.push(reply.slice(last));
  return out;
}

const COUNSELOR_VOICE = /^(i think|i'd|i would|i wonder|i like|i love|i'm|i am|i don't|i do not|i can't|i cannot|i can|i see|i notice|i noticed|i suggest|i want|i believe|i get|i hear|i mean|i wouldn't)\b/;

export interface DraftCheck {
  drafted: boolean;
  reason?: string;
}

/**
 * Looks for essay text written by the model: long quoted passages that are not
 * the student's words, or a run of first-person story sentences.
 */
export function looksDrafted(reply: string, studentText: string): DraftCheck {
  const parts = splitQuotes(reply, studentText);
  const invented = parts.filter((p): p is QuotedSpan => typeof p !== 'string' && !p.yours);
  const longest = Math.max(0, ...invented.map((q) => wordCount(q.text)));
  const total = invented.reduce((n, q) => n + wordCount(q.text), 0);
  if (longest > 25) return { drafted: true, reason: 'a long passage that is not from the essay' };
  if (total > 60) return { drafted: true, reason: 'too much example text' };

  // Outside quotes: three first-person story sentences in a row read like a draft.
  const prose = parts.filter((p): p is string => typeof p === 'string').join(' ');
  let run = 0;
  for (const raw of prose.split(/(?<=[.!?])\s+|\n+/)) {
    const s = norm(raw).replace(/^[-–•*\d.)\s]+/, '');
    if (!s) continue;
    const story = /\b(i|my|me|we|our)\b/.test(s) && !/\b(you|your|you're|you've)\b/.test(s) && !COUNSELOR_VOICE.test(s) && !s.endsWith('?') && wordCount(s) >= 6;
    run = story ? run + 1 : 0;
    if (run >= 3) return { drafted: true, reason: 'sentences written as if they were the essay' };
  }
  return { drafted: false };
}

/** True when `quote` appears word for word in `text` (ignoring case, spacing and quote style). */
export function isVerbatim(quote: string, text: string): boolean {
  const q = norm(quote).replace(/^[\s.,;:!?…"]+|[\s.,;:!?…"]+$/g, '');
  return q.length > 0 && norm(text).includes(q);
}
