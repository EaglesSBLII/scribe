/**
 * Turns what Whisper heard into essay text, in code, with fixed rules.
 * It may only remove words (fillers, repeats, spoken commands) and add
 * punctuation, capitals and breaks. `guard` proves it added no words.
 */

export interface HeardWord {
  text: string;
  /** Seconds from the start of the audio chunk, when Whisper provides them. */
  start?: number;
  end?: number;
  /** How sure Whisper was of this word, 0 to 1, when it says. */
  p?: number;
}

export type Piece =
  | { t: 'text'; text: string }
  | { t: 'flag'; text: string; alt: string; cap?: boolean }
  | { t: 'break' };

export interface CleanOptions {
  /** The speaker stopped: close the sentence with a period if nothing else ends it. */
  final?: boolean;
  /** The text continues an unfinished sentence, so it does not start with a capital. */
  continuing?: boolean;
}

export interface CleanResult {
  pieces: Piece[];
  /** Plain rendering; paragraph breaks are blank lines. */
  text: string;
}

interface Tok {
  lead: string;
  core: string;
  trail: string;
  key: string;
  start?: number;
  end?: number;
}

type Item =
  | { k: 'word'; tok: Tok }
  | { k: 'mark'; mark: string; spoken: string; sure: boolean }
  | { k: 'literal'; tok: Tok[]; alt: string }
  | { k: 'open' }
  | { k: 'close' }
  | { k: 'break' };

const TERMINAL = /[.?!]["”')\]]*$/;

// Hesitation sounds, however long they are drawn out: "um", "uhhhh", "ummmm", "errr", "hmmm", "ahhh".
// Short "ah", "oh" and "eh" are words people mean, so they stay.
const FILLER_SHAPE = /^(u+h+m*|u+m+|e+r+m+|er|e+r{3,}|e{2,}r+|h+m+|m{2,}|a{2,}h+|a+h{2,}|e+h{2,}|u{3,})$/;
const HARD_FILLERS = { has: (key: string) => FILLER_SHAPE.test(key.replace(/[^a-z]/g, '')) };

// "like" after one of these is a real word ("I like boats", "looks like rain").
const LIKE_IS_REAL_AFTER = new Set([
  'i', 'you', 'we', 'they', 'he', 'she', 'it', 'who', 'people', 'would', "i'd", "we'd", "you'd", "they'd", "he'd",
  "she'd", 'to', 'do', 'did', 'does', "don't", "didn't", "doesn't", 'not', 'really', 'also', 'still', 'always',
  'never', 'just', 'look', 'looks', 'looked', 'feel', 'feels', 'felt', 'sound', 'sounds', 'sounded', 'seem',
  'seems', 'seemed', 'is', 'was', 'are', 'were', "it's", "that's", 'be', 'been', 'much', 'more', 'most', 'anything',
  'something', 'nothing', 'things', 'and', 'or', 'but', 'exactly', 'kind', 'kinda', 'lot',
]);

// Words that are sometimes deliberately said twice.
const ALLOWED_DOUBLE = new Set(['had', 'that', 'very', 'really', 'so', 'no', 'bye', 'ha', 'much', 'many', 'far', 'long']);

const DETERMINERS = new Set([
  'a', 'an', 'the', 'this', 'that', 'these', 'those', 'each', 'every', 'any', 'some', 'no', 'one', 'another', 'my',
  'your', 'his', 'her', 'its', 'our', 'their', 'same', 'whole', 'entire', 'what', 'which',
]);

interface CommandRule {
  /** Token keys that make up the spoken command. */
  words: string[];
  mark: string;
  /** Words right before it that mean it is being talked about, not used. */
  literalAfter: string[];
  /** Words right after it that mean the sentence carries on with it. */
  literalBefore: string[];
}

const PUNCTUATION_RULES: CommandRule[] = [
  { words: ['question', 'mark'], mark: '?', literalAfter: ['big'], literalBefore: ['is', 'was', 'over', 'about', 'hanging'] },
  { words: ['exclamation', 'point'], mark: '!', literalAfter: [], literalBefore: ['is', 'was', 'on', 'to'] },
  { words: ['exclamation', 'mark'], mark: '!', literalAfter: [], literalBefore: ['is', 'was', 'on', 'to'] },
  { words: ['full', 'stop'], mark: '.', literalAfter: ['complete'], literalBefore: ['is', 'was'] },
  {
    words: ['period'], mark: '.',
    literalAfter: [
      'time', 'trial', 'class', 'grace', 'waiting', 'free', 'lunch', 'long', 'short', 'brief', 'colonial', 'historical',
      'first', 'second', 'third', 'fourth', 'fifth', 'sixth', 'seventh', 'eighth', 'last', 'next',
    ],
    literalBefore: ['of', 'was', 'is', 'were', 'when', 'where', 'in', 'during', 'lasted', 'ended', 'began', 'between', 'piece', 'drama'],
  },
  { words: ['comma'], mark: ',', literalAfter: ['oxford', 'serial', 'extra', 'missing'], literalBefore: ['splice', 'splices', 'is', 'was', 'rule', 'rules'] },
  { words: ['semicolon'], mark: ';', literalAfter: [], literalBefore: ['is', 'was'] },
  { words: ['colon'], mark: ':', literalAfter: ['semi'], literalBefore: ['is', 'was', 'cancer'] },
];

const DASH_LITERAL_AFTER = new Set([
  'i', 'we', 'they', 'you', 'he', 'she', 'to', 'will', 'would', 'can', 'could', 'must', 'mad', 'yard', 'meter', 'quick', 'em', 'en',
]);
const DASH_LITERAL_BEFORE = new Set(['of', 'to', 'for', 'across', 'off', 'through', 'out', 'into', 'away', 'is', 'was']);
const BREAK_LITERAL_BEFORE = new Set(['of', 'in', 'about', 'for', 'is', 'was', 'that', 'which']);
const QUOTE_LITERAL_AFTER = new Set(['favorite', 'famous', 'direct', 'great', 'good', 'old', 'price']);
const QUOTE_LITERAL_BEFORE = new Set(['from', 'by', 'of', 'is', 'was', 'that', 'about', 'says', 'said', 'me', 'him', 'her', 'them']);

const PAUSE = 0.35;

function tokenize(input: HeardWord[] | string): Tok[] {
  const heard: HeardWord[] =
    typeof input === 'string' ? input.split(/\s+/).filter(Boolean).map((text) => ({ text })) : input;
  const toks: Tok[] = [];
  let inBracket = false;
  for (const h of heard) {
    for (const raw of h.text.trim().split(/\s+/).filter(Boolean)) {
      // Whisper notes such as [BLANK_AUDIO] or (music) are not speech.
      if (!inBracket && /^[[(]/.test(raw)) inBracket = true;
      if (inBracket) {
        if (/[\])][.,!?]*$/.test(raw)) inBracket = false;
        continue;
      }
      const m = raw.match(/^([^\p{L}\p{N}$]*)(.*?)([^\p{L}\p{N}%$]*)$/u)!;
      const tok: Tok = {
        // Whisper writes a hesitation as "..."; that is not punctuation the speaker chose.
        lead: m[1], core: m[2], trail: m[3].replace(/\.{2,}|…/g, ''),
        key: m[2].toLowerCase().replace(/’/g, "'"),
        start: h.start, end: h.end,
      };
      if (!tok.core) {
        // Bare punctuation belongs to the word before it.
        const prev = toks.at(-1);
        if (prev && /^[.,!?;:…]+$/.test(raw)) prev.trail += raw;
        continue;
      }
      toks.push(tok);
    }
  }
  return toks;
}

/** The pieces of speech that count as words, for comparing input and output. */
export function wordUnits(text: string): string[] {
  return text.toLowerCase().replace(/’/g, "'").match(/[\p{L}\p{N}]+(?:'[\p{L}\p{N}]+)*/gu) ?? [];
}

/** True when every word of `output` appears in `input`, in the same order. */
export function guard(input: string, output: string): boolean {
  const source = wordUnits(input);
  let i = 0;
  for (const w of wordUnits(output)) {
    while (i < source.length && source[i] !== w) i++;
    if (i === source.length) return false;
    i++;
  }
  return true;
}

function matchAt(toks: Tok[], i: number, words: string[]): boolean {
  return words.every((w, j) => toks[i + j]?.key === w && (j === words.length - 1 || !toks[i + j].trail));
}

/**
 * Is the word at `i` being named ("the Jurassic period") rather than used as a command?
 * 'sure' when a determiner or a known describing word comes right before it, or a
 * determiner and then a capitalised name; 'maybe' for a determiner two words back.
 */
function namedBy(toks: Tok[], i: number, extra: Set<string> | string[]): 'sure' | 'maybe' | 'no' {
  const set = extra instanceof Set ? extra : new Set(extra);
  const isDet = (t: Tok) => DETERMINERS.has(t.key) || t.key.endsWith("'s");
  const p1 = toks[i - 1];
  if (!p1 || TERMINAL.test(p1.trail)) return 'no';
  if (isDet(p1) || set.has(p1.key)) return 'sure';
  const p2 = toks[i - 2];
  if (!p2 || TERMINAL.test(p2.trail) || !isDet(p2)) return 'no';
  return /^\p{Lu}/u.test(p1.core) ? 'sure' : 'maybe';
}

function gap(a: Tok | undefined, b: Tok | undefined): number | undefined {
  if (!a || !b || a.end === undefined || b.start === undefined) return undefined;
  return b.start - a.end;
}

function toItems(toks: Tok[]): Item[] {
  const items: Item[] = [];
  let quoteOpen = false;
  const hasClose = (from: number) =>
    toks.slice(from).some((t, j) => t.key === 'unquote' || t.key === 'endquote' ||
      ((t.key === 'end' || t.key === 'close') && toks[from + j + 1]?.key === 'quote'));

  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    const prev = toks[i - 1];

    // Paragraph and line breaks.
    if (t.key === 'new' && !t.trail && (toks[i + 1]?.key === 'paragraph' || toks[i + 1]?.key === 'line')) {
      const next = toks[i + 2];
      const literal = (prev !== undefined && !TERMINAL.test(prev.trail) && (DETERMINERS.has(prev.key) || prev.key === 'brand')) ||
        (next !== undefined && BREAK_LITERAL_BEFORE.has(next.key));
      if (!literal) {
        items.push({ k: 'break' });
        i += 1;
        continue;
      }
    }

    // Quotation marks.
    const closeLen = t.key === 'unquote' || t.key === 'endquote' ? 1
      : (t.key === 'end' || t.key === 'close') && !t.trail && toks[i + 1]?.key === 'quote' ? 2 : 0;
    if (closeLen && quoteOpen) {
      items.push({ k: 'close' });
      quoteOpen = false;
      i += closeLen - 1;
      continue;
    }
    const openLen = t.key === 'open' && !t.trail && toks[i + 1]?.key === 'quote' ? 2 : t.key === 'quote' ? 1 : 0;
    if (openLen && !quoteOpen) {
      const next = toks[i + openLen];
      const literal = openLen === 1 &&
        (namedBy(toks, i, QUOTE_LITERAL_AFTER) !== 'no' || !next || QUOTE_LITERAL_BEFORE.has(next.key));
      if (!literal && (openLen === 2 || hasClose(i + openLen))) {
        items.push({ k: 'open' });
        quoteOpen = true;
        i += openLen - 1;
        continue;
      }
    }

    // Dash.
    if (t.key === 'dash') {
      const next = toks[i + 1];
      const literal = namedBy(toks, i, DASH_LITERAL_AFTER) !== 'no' || !next || DASH_LITERAL_BEFORE.has(next.key);
      if (!literal) {
        const before = gap(prev, t);
        const after = gap(t, next);
        const sure = (before !== undefined && after !== undefined && before >= PAUSE && after >= PAUSE) ||
          (!!prev && prev.trail.includes(',') && t.trail.includes(','));
        items.push({ k: 'mark', mark: '—', spoken: 'dash', sure });
        continue;
      }
    }

    // Sentence punctuation.
    const rule = PUNCTUATION_RULES.find((r) => matchAt(toks, i, r.words));
    if (rule && i > 0) {
      const last = toks[i + rule.words.length - 1];
      const next = toks[i + rule.words.length];
      const spoken = rule.words.join(' ');
      const named = namedBy(toks, i, rule.literalAfter);
      const carriesOn = next !== undefined && rule.literalBefore.includes(next.key);
      const span = toks.slice(i, i + rule.words.length);
      const pausedBefore = (gap(prev, t) ?? 0) >= PAUSE;
      if (named === 'sure' || (named === 'maybe' && carriesOn)) {
        // "the Jurassic period", "a long period of time": certainly a word.
      } else if (carriesOn || (named === 'maybe' && !pausedBefore)) {
        // Probably a word, but not certainly: offer the other reading.
        items.push({ k: 'literal', tok: span, alt: rule.mark });
        i += rule.words.length - 1;
        continue;
      } else if (named === 'maybe') {
        items.push({ k: 'mark', mark: rule.mark, spoken, sure: false });
        i += rule.words.length - 1;
        continue;
      } else {
        const after = gap(last, next);
        const sure = !next || (after !== undefined && after >= PAUSE) || /[,.]$/.test(prev.trail) || TERMINAL.test(last.trail);
        // Keep a question or exclamation mark Whisper put on the command word itself.
        const own = last.trail.match(/[?!]/)?.[0];
        items.push({ k: 'mark', mark: own && rule.mark === '.' ? own : rule.mark, spoken, sure });
        i += rule.words.length - 1;
        continue;
      }
    }

    items.push({ k: 'word', tok: { ...t } });
  }
  return items;
}

/** Remove a word and tidy the punctuation it carried. */
function dropWord(items: Item[], index: number) {
  const gone = (items[index] as { tok: Tok }).tok;
  const before = items[index - 1];
  const after = items[index + 1];
  if (before?.k === 'word') {
    const prev = before.tok;
    if (TERMINAL.test(gone.trail) && !TERMINAL.test(prev.trail)) {
      prev.trail = prev.trail.replace(/[,;:]+$/, '') + gone.trail;
    } else if (gone.trail.includes(',') && prev.trail.endsWith(',')) {
      // ", um," was set off by two commas; neither belongs once it is gone.
      prev.trail = prev.trail.slice(0, -1);
    }
  }
  if (gone.lead && after?.k === 'word') after.tok.lead = gone.lead + after.tok.lead;
  items.splice(index, 1);
}

const wordAt = (items: Item[], i: number): Tok | undefined => {
  const it = items[i];
  return it?.k === 'word' ? it.tok : undefined;
};

function removeFillers(items: Item[]) {
  // Remember where "um"/"uh" were, because a "like" next to one is a filler too.
  const nextToFiller = new Set<Tok>();
  for (let i = 0; i < items.length; i++) {
    const t = wordAt(items, i);
    if (!t || !HARD_FILLERS.has(t.key)) continue;
    for (const n of [wordAt(items, i - 1), wordAt(items, i + 1)]) if (n) nextToFiller.add(n);
  }
  for (let i = items.length - 1; i >= 0; i--) {
    const t = wordAt(items, i);
    if (t && HARD_FILLERS.has(t.key)) dropWord(items, i);
  }

  for (let i = items.length - 1; i >= 0; i--) {
    const t = wordAt(items, i);
    if (!t) continue;
    const prev = wordAt(items, i - 1);
    const next = wordAt(items, i + 1);
    const startsSentence = !prev || TERMINAL.test(prev.trail);

    if (t.key === 'like') {
      const realAfterPrev = !!prev && !TERMINAL.test(prev.trail) && !prev.trail.includes(',') && LIKE_IS_REAL_AFTER.has(prev.key);
      const setOff = t.trail.includes(',') && (startsSentence || prev!.trail.includes(','));
      const before = gap(prev, t);
      const after = gap(t, next);
      const paused = before !== undefined && after !== undefined && before >= PAUSE && after >= PAUSE;
      if (!realAfterPrev && (setOff || nextToFiller.has(t) || paused)) dropWord(items, i);
    } else if (t.key === 'know' && prev?.key === 'you' && !prev.trail && t.trail.includes(',')) {
      // "you know," set off by commas or opening a sentence.
      const beforeYou = wordAt(items, i - 2);
      if (!beforeYou || TERMINAL.test(beforeYou.trail) || beforeYou.trail.includes(',')) {
        prev.trail = t.trail;
        items.splice(i, 1);
        dropWord(items, i - 1);
        i--;
      }
    }
  }
}

function removeRepeats(items: Item[]) {
  // Cut-off words: "b-b-boat" becomes "boat"; a dangling "w-" goes.
  for (let i = items.length - 1; i >= 0; i--) {
    const t = wordAt(items, i);
    if (!t) continue;
    const stutter = t.core.match(/^(?:(\p{L}{1,3})-)+(\p{L}+)$/u);
    if (stutter && stutter[2].toLowerCase().startsWith(stutter[1].toLowerCase())) {
      t.core = stutter[2];
      t.key = t.core.toLowerCase();
    } else if (/^\p{L}{1,4}-$/u.test(t.core) || (t.core.length <= 4 && /^(-|—|\.\.\.|…)/.test(t.trail) && wordAt(items, i + 1)?.key.startsWith(t.key))) {
      dropWord(items, i);
    }
  }
  // Restarts: the same one to three words said twice in a row keep the second.
  for (let n = 3; n >= 1; n--) {
    for (let i = 0; i + 2 * n <= items.length; i++) {
      const first: Tok[] = [];
      const second: Tok[] = [];
      for (let j = 0; j < n; j++) {
        const a = wordAt(items, i + j);
        const b = wordAt(items, i + n + j);
        if (a && b) {
          first.push(a);
          second.push(b);
        }
      }
      if (first.length < n) continue;
      if (!first.every((a, j) => a.key === second[j].key)) continue;
      if (first.some((a) => TERMINAL.test(a.trail))) continue;
      if (first.every((a) => ALLOWED_DOUBLE.has(a.key) || /^\d/.test(a.key))) continue;
      for (let j = n - 1; j >= 0; j--) {
        // Whatever comma the first copy had is part of the stumble.
        first[j].trail = '';
        dropWord(items, i + j);
      }
      i--;
    }
  }
}

function capitalise(word: string): string {
  return word.replace(/\p{L}/u, (c) => c.toUpperCase());
}

function render(items: Item[], opts: CleanOptions): Piece[] {
  const pieces: Piece[] = [];
  let cur = '';
  let capNext = !opts.continuing;
  let needSpace = false;
  let firstWord = true;
  let pendingFlag: Extract<Piece, { t: 'flag' }> | null = null;

  const flush = () => {
    if (cur) pieces.push({ t: 'text', text: cur });
    cur = '';
  };
  const emitted = () => cur || pieces.findLast((p) => p.t !== 'break');
  const endsSentence = () => {
    if (cur) return TERMINAL.test(cur);
    const last = pieces.at(-1);
    return !last || last.t === 'break' || TERMINAL.test(last.text);
  };

  const emitWord = (t: Tok) => {
    let core = t.core;
    if (/^i('|$)/.test(t.key)) core = capitalise(core);
    const wasLower = /^\p{Ll}/u.test(core);
    if (capNext) core = capitalise(core);
    else if (firstWord && opts.continuing && !/^i('|$)/.test(t.key) && /^\p{Lu}\p{Ll}/u.test(core)) {
      // Whisper capitalises the start of every chunk; this one is mid-sentence.
      core = core[0].toLowerCase() + core.slice(1);
    }
    if (pendingFlag) {
      if (capNext && wasLower) pendingFlag.cap = true;
      pendingFlag = null;
    }
    cur += (needSpace ? ' ' : '') + t.lead + core + t.trail;
    needSpace = true;
    firstWord = false;
    capNext = TERMINAL.test(t.trail);
  };

  for (const item of items) {
    switch (item.k) {
      case 'word':
        emitWord(item.tok);
        break;
      case 'literal': {
        flush();
        const text = (needSpace ? ' ' : '') + item.tok.map((t) => t.lead + t.core + t.trail).join(' ');
        pieces.push({ t: 'flag', text, alt: item.alt });
        needSpace = true;
        firstWord = false;
        capNext = TERMINAL.test(item.tok.at(-1)!.trail);
        break;
      }
      case 'mark': {
        if (!emitted()) break;
        const isDash = item.mark === '—';
        // The spoken mark replaces any softer punctuation Whisper guessed there.
        if (cur) cur = cur.replace(isDash ? /[,;:]+$/ : /[.,;:]+$/, '');
        if (!isDash && cur && /[?!]$/.test(cur)) break;
        const text = isDash ? ' —' : item.mark;
        if (item.sure) {
          cur += text;
        } else {
          flush();
          pendingFlag = { t: 'flag', text, alt: ` ${item.spoken}` };
          pieces.push(pendingFlag);
        }
        needSpace = true;
        capNext = /[.?!]/.test(item.mark);
        break;
      }
      case 'open':
        cur += (needSpace ? ' ' : '') + '“';
        needSpace = false;
        break;
      case 'close':
        cur += '”';
        needSpace = true;
        break;
      case 'break':
        if (!endsSentence()) cur += '.';
        flush();
        if (pieces.at(-1)?.t !== 'break') pieces.push({ t: 'break' });
        needSpace = false;
        capNext = true;
        pendingFlag = null;
        break;
    }
  }
  if (opts.final && emitted() && !endsSentence()) {
    if (cur) cur += '.';
    else pieces.push({ t: 'text', text: '.' });
  }
  flush();
  return pieces;
}

export function piecesText(pieces: Piece[]): string {
  return pieces.map((p) => (p.t === 'break' ? '\n\n' : p.text)).join('');
}

/** Clean one stretch of dictated speech. */
export function clean(input: HeardWord[] | string, opts: CleanOptions = {}): CleanResult {
  const toks = tokenize(input);
  const raw = toks.map((t) => t.lead + t.core + t.trail).join(' ');
  const items = toItems(toks);
  removeFillers(items);
  removeRepeats(items);
  let pieces = render(items, opts);
  if (!guard(raw, piecesText(pieces))) {
    // Never risk inventing a word: fall back to exactly what was heard.
    pieces = raw ? [{ t: 'text', text: raw }] : [];
  }
  return { pieces, text: piecesText(pieces) };
}
