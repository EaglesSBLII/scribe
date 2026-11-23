/** Deterministic sentence splitting and word counting. No model is involved. */

export interface Sentence {
  /** Offsets into the paragraph text; `end` excludes trailing whitespace. */
  start: number;
  end: number;
  text: string;
}

// A sentence break is not allowed right after one of these.
const ABBREVIATIONS = new Set([
  'mr', 'mrs', 'ms', 'dr', 'prof', 'sr', 'jr', 'st', 'vs', 'etc', 'e.g', 'i.e',
  'u.s', 'u.k', 'a.m', 'p.m', 'no', 'fig', 'eq', 'inc', 'ltd', 'co', 'mt', 'gen',
  'col', 'lt', 'sgt', 'rev', 'approx', 'dept', 'univ',
]);

const segmenter = new Intl.Segmenter('en', { granularity: 'sentence' });

function endsWithAbbreviation(piece: string): boolean {
  const m = piece.trimEnd().match(/([A-Za-z][A-Za-z.]*)\.$/);
  if (!m) return false;
  const word = m[1].toLowerCase();
  // A single capital letter followed by a period is an initial ("J. K. Rowling").
  return ABBREVIATIONS.has(word) || /^[a-z]$/.test(word);
}

export function sentences(text: string): Sentence[] {
  const out: Sentence[] = [];
  let pendingStart = -1;
  for (const seg of segmenter.segment(text)) {
    const start = pendingStart >= 0 ? pendingStart : seg.index;
    const rawEnd = seg.index + seg.segment.length;
    const piece = text.slice(start, rawEnd);
    if (endsWithAbbreviation(piece) && rawEnd < text.length) {
      pendingStart = start;
      continue;
    }
    pendingStart = -1;
    const trimmed = piece.trimEnd();
    const lead = trimmed.length - trimmed.trimStart().length;
    if (trimmed.trim().length === 0) continue;
    out.push({ start: start + lead, end: start + trimmed.length, text: trimmed.trimStart() });
  }
  return out;
}

const WORD = /[\p{L}\p{N}]+(?:['’.\-][\p{L}\p{N}]+)*/gu;

/** Words as a list. Hyphenated words and contractions count once. */
export function words(text: string): string[] {
  return text.match(WORD) ?? [];
}

/**
 * The one word counter the whole app uses. It counts the way word processors
 * and application forms do: anything between spaces that contains a letter or
 * a digit is one word. "well-known", "don't" and "3.5" are one word each; a
 * dash standing on its own is not a word.
 */
export function countWords(text: string): number {
  let n = 0;
  // A piece of mathematics counts as one word, however it is written.
  const plain = text.replace(/\$\$[^$]+\$\$|\$[^$\n]+\$/g, ' MATH ');
  for (const piece of plain.split(/\s+/)) if (/[\p{L}\p{N}]/u.test(piece)) n++;
  return n;
}
