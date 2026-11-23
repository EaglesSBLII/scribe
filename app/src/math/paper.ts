/**
 * What one spoken utterance means when math mode is on. Still transcription
 * only: headings, captions and equations are the speaker's own words, set in
 * the right place.
 */
import { clean, type HeardWord } from '../dictation/clean';
import type { Inline } from '../doc/types';
import { isMathUtterance, spokenToLatex } from './spoken';

export type PaperUtterance =
  /** A whole paragraph of its own: heading, caption or numbered equation. */
  | { k: 'block'; nodes: Inline[] }
  /** Text and mathematics to add to the current paragraph. */
  | { k: 'inline'; pieces: (Inline | { t: 'break' })[] };

const plain = (words: HeardWord[]) => words.map((w) => w.text).join(' ').replace(/\s+/g, ' ').trim();
const keyOf = (w: HeardWord) => w.text.toLowerCase().replace(/[^a-z]/g, '');

function title(words: HeardWord[]): string {
  // A heading is the speaker's words, cleaned of fillers, without a closing period.
  return clean(words, { final: false }).text.replace(/[.,;:]+$/, '').trim();
}

/** Returns null when the utterance is ordinary prose with no mathematics in it. */
export function readPaperUtterance(heard: HeardWord[], paused: boolean, continuing: boolean): PaperUtterance | null {
  const words = heard.flatMap((h) => h.text.trim().split(/\s+/).filter(Boolean).map((text) => ({ ...h, text })));
  const keys = words.map(keyOf);
  let start = keys[0] === 'new' ? 1 : 0;
  const rest = () => words.slice(start + 1);

  if (keys[start] === 'heading' && words.length > start + 1) return { k: 'block', nodes: [{ t: 'text', text: `# ${title(rest())}` }] };
  if (keys[start] === 'subheading' && words.length > start + 1) return { k: 'block', nodes: [{ t: 'text', text: `## ${title(rest())}` }] };
  if (keys[start] === 'figure' && keys[start + 1] === 'caption') start++;
  if (keys[start] === 'caption' && words.length > start + 1) {
    return { k: 'block', nodes: [{ t: 'text', text: `Figure: ${clean(rest(), { final: true }).text}` }] };
  }
  if (keys[start] === 'equation' && words.length > start + 1) {
    const { latex } = spokenToLatex(plain(rest()));
    return latex ? { k: 'block', nodes: [{ t: 'math', latex, display: true }] } : null;
  }

  // "... is math one half m v squared end math ..." inside a sentence.
  const open = keys.indexOf('math');
  const close = keys.findIndex((k, i) => i > open && k === 'end' && keys[i + 1] === 'math');
  if (open >= 0 && close > open + 1) {
    const before = clean(words.slice(0, open), { final: false, continuing }).pieces;
    const { latex } = spokenToLatex(plain(words.slice(open + 1, close)));
    const tail = words.slice(close + 2);
    const after = tail.length ? clean(tail, { final: paused, continuing: true }).pieces : [];
    const lead: Inline[] = before.length ? [{ t: 'text', text: ' ' }] : [];
    const trail: Inline[] = after.length && after[0].t === 'text' && !/^[.,;:!?]/.test(after[0].text) ? [{ t: 'text', text: ' ' }] : [];
    return { k: 'inline', pieces: [...before, ...lead, { t: 'math', latex }, ...trail, ...after] };
  }

  // An utterance that is mathematics from start to finish.
  const said = plain(words);
  if (isMathUtterance(said)) return { k: 'inline', pieces: [{ t: 'math', latex: spokenToLatex(said).latex }] };
  return null;
}
