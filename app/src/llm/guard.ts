/**
 * Checks on what the model says, done in code. The model is told not to draft
 * essay text; these checks catch it when it does anyway.
 */

const norm = (s: string) => s.toLowerCase().replace(/[’‘]/g, "'").replace(/[“”]/g, '"').replace(/\s+/g, ' ').trim();
const wordCount = (s: string) => (s.match(/[\p{L}\p{N}]+/gu) ?? []).length;

/** Did the student ask the counselor to write for them? */
export function asksForWriting(message: string): boolean {
  const m = norm(message);
  return (
    /\b(write|rewrite|draft|compose|generate|redo|reword|rephrase|fix up|polish|finish|continue)\b.{0,60}\b(essay|paragraph|paragraphs|intro|introduction|opening|conclusion|ending|sentence|sentences|hook|it|this|that)\b/.test(m) ||
    /\b(can|could|would|will) you (just )?(write|rewrite|draft)\b/.test(m) ||
    /\bgive me (a|an|the) (paragraph|intro|introduction|opening|conclusion|draft|essay)\b/.test(m)
  );
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
