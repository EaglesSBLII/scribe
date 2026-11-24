/**
 * Turns a spoken sentence into a structured command, using a fixed grammar.
 * No model is involved. Anything that does not match the whole grammar is not
 * a command and is treated as dictation.
 */
import type { HeardWord } from '../dictation/clean';

/** Paragraph and sentence numbers are 1-based, as spoken. */
export type ParaRef = number | 'last' | 'current';
export type SentRef = number | 'last';

export type InsertPlace =
  | { k: 'after'; sent: SentRef }
  | { k: 'before'; sent: SentRef }
  | { k: 'between'; a: number; b: number }
  | { k: 'start' }
  | { k: 'end' };

export type Command =
  | { k: 'undo' }
  | { k: 'redo' }
  | { k: 'count'; scope: 'essay' | 'left' }
  | { k: 'count'; scope: 'paragraph'; para: ParaRef }
  | { k: 'read'; what: 'essay' }
  | { k: 'read'; what: 'paragraph'; para: ParaRef }
  | { k: 'read'; what: 'sentence'; sent: SentRef; para?: ParaRef }
  | { k: 'delete'; what: 'sentences'; from: SentRef; to?: number; para?: ParaRef }
  | { k: 'delete'; what: 'paragraph'; para: ParaRef }
  | { k: 'move'; para: ParaRef; where: 'above' | 'below'; target: ParaRef }
  | { k: 'move'; para: ParaRef; where: 'top' | 'bottom' | 'up' | 'down' }
  | { k: 'replace'; find: string; with: string; para?: ParaRef }
  /** `words` is the dictated text to insert, exactly as heard. */
  | { k: 'insert'; words: HeardWord[]; at: InsertPlace; para?: ParaRef }
  /** "Delete what I just said": the last dictated utterance. */
  | { k: 'deleteUtterance' }
  /** "Delete the last 5 words". `where` is filled in once Scribe knows which words are meant. */
  | { k: 'deleteWords'; count: number; where?: 'here' | 'end' }
  /** "Go back to the sentence about the boat": found by meaning, then confirmed. */
  | { k: 'goto'; about: string }
  | { k: 'gotoEnd' }
  /** How much the counselor speaks up. */
  | { k: 'mode'; mode: 'draft' | 'coach' | 'conversation' };

const NUMBER_WORDS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
  thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20,
  // What Whisper sometimes writes when a number was said.
  to: 2, too: 2, for: 4, won: 1,
};
const ORDINAL_WORDS: Record<string, number> = {
  first: 1, second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6, seventh: 7, eighth: 8, ninth: 9, tenth: 10,
};

const NUM = `\\d+|${Object.keys(NUMBER_WORDS).join('|')}`;
const ORD = `\\d+(?:st|nd|rd|th)|last|final|${Object.keys(ORDINAL_WORDS).join('|')}`;

/** "paragraph 3", "the third paragraph", "this paragraph". */
const para = (tag: string) =>
  `(?:paragraph (?<${tag}n>${NUM})|(?:the |that |my )?(?<${tag}o>${ORD}) paragraph|(?<${tag}c>this|the current) paragraph)`;
/** "sentence 2", "the last sentence". */
const sent = (tag: string) => `(?:sentence (?<${tag}n>${NUM})|(?:the |that |my )?(?<${tag}o>${ORD}) sentence)`;
const inPara = (tag: string) => `(?: (?:in|of|from) ${para(tag)})?`;

function num(word: string): number {
  return /^\d+/.test(word) ? parseInt(word, 10) : (NUMBER_WORDS[word] ?? ORDINAL_WORDS[word]);
}

type Groups = Record<string, string | undefined>;

function paraRef(g: Groups, tag: string): ParaRef | undefined {
  if (g[`${tag}c`]) return 'current';
  const o = g[`${tag}o`];
  if (o) return o === 'last' || o === 'final' ? 'last' : num(o);
  const n = g[`${tag}n`];
  return n ? num(n) : undefined;
}

function sentRef(g: Groups, tag: string): SentRef | undefined {
  const o = g[`${tag}o`];
  if (o) return o === 'last' || o === 'final' ? 'last' : num(o);
  const n = g[`${tag}n`];
  return n ? num(n) : undefined;
}

const PLACE =
  `(?:between sentences? (?<ba>${NUM}) and (?<bb>${NUM})|after ${sent('af')}|before ${sent('be')}|at the (?<edge>start|beginning|end))`;

function place(g: Groups): InsertPlace {
  if (g.ba && g.bb) return { k: 'between', a: num(g.ba), b: num(g.bb) };
  const after = sentRef(g, 'af');
  if (after) return { k: 'after', sent: after };
  const before = sentRef(g, 'be');
  if (before) return { k: 'before', sent: before };
  return g.edge === 'end' ? { k: 'end' } : { k: 'start' };
}

interface Rule {
  re: RegExp;
  build(g: Groups, slice: (group: string) => Tok[]): Command | null;
}

const rule = (pattern: string, build: Rule['build']): Rule => ({ re: new RegExp(`^(?:${pattern})$`, 'd'), build });
const VERB_INSERT = '(?:insert|add|put)';

/**
 * Looser ways of saying things. These apply only to words said to Scribe by
 * name, or in conversation mode, where nothing said can end up in the essay.
 * On their own, while dictating, "forget it" or "my bad" may be the essay.
 */
const CASUAL_RULES: Rule[] = [
  rule(
    "forget (?:that|it|about (?:that|it))|not that|oops|whoops|my bad|my mistake|(?:i )?didn't mean (?:that|it|to say that)|that's not what i meant|that (?:was|is|came out) wrong|no not that",
    () => ({ k: 'deleteUtterance' }),
  ),
  // "ando" and "undue" are how Whisper sometimes writes "undo".
  rule('(?:go|step) back(?: one)?(?: step)?|back up|(?:ando|undue|on do|and do)(?: (?:ando|that|it))?', () => ({ k: 'undo' })),
  rule('do (?:that|it) again|put (?:that|it) back in', () => ({ k: 'redo' })),
  rule(
    "am i over(?: the limit| the word limit)?|how much (?:room|space)(?: do i have| is)? left|how many more(?: words)?(?: can i (?:write|add)| do i (?:get|have))?|how close am i(?: to the limit)?",
    () => ({ k: 'count', scope: 'left' }),
  ),
  rule(
    "how long is (?:it|this|that|my essay|the essay)(?: so far| now)?|(?:what|where) am i at|what's my count|how many(?: words)? (?:is that|so far)|count(?: the| my)? words",
    () => ({ k: 'count', scope: 'essay' }),
  ),
  rule("what did i(?: just)? say|what was that(?: last (?:bit|part|line|sentence))?|(?:read|say) that again", () => ({ k: 'read', what: 'sentence', sent: 'last' })),
  rule("what do i have(?: so far)?|what have i got(?: so far)?|read it from the top|from the top", () => ({ k: 'read', what: 'essay' })),
  rule("be quiet|quiet down|quiet|hush|shh+|stop talking|shut up|let me write|just listen", () => ({ k: 'mode', mode: 'draft' })),
  rule("let's talk|talk to me|talk with me|let's chat|can we talk|let's brainstorm", () => ({ k: 'mode', mode: 'conversation' })),
  rule('coach me|help me as i go|chime in', () => ({ k: 'mode', mode: 'coach' })),
  rule('keep going|carry on|continue|go to the bottom|back to writing', () => ({ k: 'gotoEnd' })),
];

const RULES: Rule[] = [
  rule('(?:oops )?(?:undo|undelete|revert|reverse|restore)(?: (?:that|it|this))?|(?:put|bring) (?:that|it) back', () => ({ k: 'undo' })),
  rule(
    "(?:no )?(?:delete|remove|erase) (?:that|it|this|(?:that|the) last (?:bit|part|thing|one)|(?:what|everything) (?:i|i've) (?:just )?said|the last thing i said)|take (?:that|it) (?:back|out)",
    () => ({ k: 'deleteUtterance' }),
  ),
  rule(
    `(?:delete|remove|erase|back up) (?:the |my |those |that )?last (?:(?<wn>${NUM}) |(?<wc>couple|couple of|few) )?words?|back up (?<wb>${NUM}) words?`,
    (g) => ({ k: 'deleteWords', count: g.wn ? num(g.wn) : g.wb ? num(g.wb) : g.wc ? (g.wc === 'few' ? 3 : 2) : 1 }),
  ),
  rule(
    '(?:go|jump|move)(?: back)? to (?:the |my )?(?:sentence|part|line|bit|place|paragraph) (?:about|where|with|on|that mentions) (?<about>.+)|find (?:the |my )?(?:sentence|part|line) (?:about|where|with) (?<about2>.+)',
    (_g, slice) => {
      const about = [...slice('about'), ...slice('about2')].map((t) => t.plain).join(' ');
      return about ? { k: 'goto', about } : null;
    },
  ),
  rule('(?:go|jump|move)(?: back)? to the (?:end|bottom)|continue (?:at|from) the end|back to the (?:end|bottom)|pick up where i left off', () => ({ k: 'gotoEnd' })),
  rule('(?:switch to |go to |use )?(?<mode>draft|coach|coaching|conversation|quiet) mode', (g) => ({
    k: 'mode',
    mode: g.mode === 'coach' || g.mode === 'coaching' ? 'coach' : g.mode === 'conversation' ? 'conversation' : 'draft',
  })),
  rule('redo(?: that)?', () => ({ k: 'redo' })),

  rule(
    `how many words(?: are| are there)? in ${para('p')}|word count (?:for|of|in) ${para('q')}`,
    (g) => ({ k: 'count', scope: 'paragraph', para: (paraRef(g, 'p') ?? paraRef(g, 'q'))! }),
  ),
  rule(
    "how many words(?: are| do i have)? (?:left|remaining)(?: (?:for|in|on) (?:this|the|my) (?:prompt|essay))?|words (?:left|remaining)",
    () => ({ k: 'count', scope: 'left' }),
  ),
  rule(
    "(?:what's|what is) (?:the|my) word count|word count|how many words(?: is (?:that|this|it)| are there| do i have| have i written)?(?: so far)?(?: in (?:the|this|my) essay)?",
    () => ({ k: 'count', scope: 'essay' }),
  ),

  rule(
    `(?:read|play|say)(?: me)?(?: back)? (?:(?<all>everything|it all|it|that|the whole thing|what i have(?: so far)?|the (?:whole |entire )?essay|my essay)(?: from the top)?|${sent('s')}${inPara('sp')}|${para('p')})(?: back)?`,
    (g) => {
      if (g.all) return { k: 'read', what: 'essay' };
      const s = sentRef(g, 's');
      if (s) return { k: 'read', what: 'sentence', sent: s, para: paraRef(g, 'sp') };
      return { k: 'read', what: 'paragraph', para: paraRef(g, 'p')! };
    },
  ),

  rule(
    `(?:delete|remove|erase|cut) (?:sentences (?<r1>${NUM}) (?:and|through|to) (?<r2>${NUM})${inPara('rp')}|${sent('s')}${inPara('sp')}|${para('p')})`,
    (g) => {
      if (g.r1 && g.r2) return { k: 'delete', what: 'sentences', from: num(g.r1), to: num(g.r2), para: paraRef(g, 'rp') };
      const s = sentRef(g, 's');
      if (s) return { k: 'delete', what: 'sentences', from: s, para: paraRef(g, 'sp') };
      return { k: 'delete', what: 'paragraph', para: paraRef(g, 'p')! };
    },
  ),

  rule(
    `move ${para('a')} (?:(?<where>above|before|below|after|under) ${para('b')}|to the (?<edge>top|start|beginning|end|bottom)|(?<dir>up|down))`,
    (g) => {
      const p = paraRef(g, 'a')!;
      if (g.where) {
        const where = g.where === 'above' || g.where === 'before' ? 'above' : 'below';
        return { k: 'move', para: p, where, target: paraRef(g, 'b')! };
      }
      if (g.edge) return { k: 'move', para: p, where: g.edge === 'end' || g.edge === 'bottom' ? 'bottom' : 'top' };
      return { k: 'move', para: p, where: g.dir as 'up' | 'down' };
    },
  ),

  rule(`(?:replace|change) (?<find>.+?) (?:with|to) (?<with>.+?)${inPara('p')}`, (g, slice) => {
    const text = (group: string) => slice(group).map((t) => t.plain).join(' ');
    const find = text('find');
    const replacement = text('with');
    return find && replacement ? { k: 'replace', find, with: replacement, para: paraRef(g, 'p') } : null;
  }),

  rule(`${VERB_INSERT} (?<x>.+) ${PLACE}${inPara('p')}`, (g, slice) => insert(g, slice)),
  rule(`(?:in ${para('lp')} )?${PLACE}${inPara('p')} ${VERB_INSERT} (?<x>.+)`, (g, slice) => insert(g, slice)),
];

function insert(g: Groups, slice: (group: string) => Tok[]): Command | null {
  const toks = slice('x');
  if (!toks.length) return null;
  const words = toks.map((t) => ({ ...t.heard }));
  // Whisper often sets the dictated part off with commas; they are not part of it.
  words[0].text = words[0].text.replace(/^[,;:\s]+/, '');
  const last = words.length - 1;
  words[last].text = words[last].text.replace(/[,;:]+$/, '');
  return { k: 'insert', words, at: place(g), para: paraRef(g, 'p') ?? paraRef(g, 'lp') };
}

interface Tok {
  /** Lower-case, no punctuation: what the grammar matches on. */
  key: string;
  /** Original spelling without surrounding punctuation or quotes. */
  plain: string;
  heard: HeardWord;
}

function tokens(input: HeardWord[] | string): Tok[] {
  const heard: HeardWord[] = typeof input === 'string' ? [{ text: input }] : input;
  const out: Tok[] = [];
  for (const h of heard) {
    for (const raw of h.text.trim().split(/\s+/).filter(Boolean)) {
      const plain = raw.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');
      if (!plain) {
        // Bare punctuation stays attached to the word before it.
        if (out.length) out[out.length - 1].heard = { ...out[out.length - 1].heard, text: out[out.length - 1].heard.text + raw };
        continue;
      }
      out.push({ key: plain.toLowerCase().replace(/’/g, "'"), plain, heard: { ...h, text: raw } });
    }
  }
  return out;
}

// Words people put in front of or after a request. They are ignored.
const LEAD = [
  'no wait', 'oh wait', 'all right', 'go ahead and', 'can you just', 'could you just', 'can you', 'could you', 'would you', 'will you',
  'i want you to', 'i need you to', "i'd like you to", 'okay', 'ok', 'alright', 'so', 'um', 'uh', 'well', 'hey', 'yo', 'oh',
  'actually', 'wait', 'now', 'and', 'then', 'just', 'please', 'kindly', 'yeah', 'yes',
].map((p) => p.split(' '));
const TRAIL = ['for me', 'real quick', 'right now', 'thank you', 'thanks', 'please', 'now', 'okay', 'ok', 'will you', 'would you'].map((p) => p.split(' '));

// Other ways to say "delete", as the first word of a request.
const DELETE_PHRASES = [['get', 'rid', 'of'], ['take', 'out'], ['cut', 'out'], ['take', 'away'], ['throw', 'out'], ['throw', 'away'], ['cross', 'out'], ['wipe', 'out']];
const DELETE_WORDS = new Set([
  'scratch', 'strike', 'scrap', 'nix', 'kill', 'nuke', 'ditch', 'trash', 'axe', 'ax', 'zap', 'wipe', 'lose', 'drop', 'toss', 'chop', 'dump', 'yeet', 'cut', 'clear', 'bin',
  // Whisper sometimes hears the past tense.
  'deleted', 'removed', 'erased', 'scratched', 'nuked', 'killed', 'scrapped', 'ditched', 'dropped',
]);

const startsWith = (toks: Tok[], phrase: string[], at = 0) => phrase.every((w, i) => toks[at + i]?.key === w);

/** Strip filler around a request and bring slang for "delete" back to the one word the grammar knows. */
function simplify(input: Tok[]): Tok[] {
  let toks = input;
  for (let again = true; again && toks.length > 1; ) {
    again = false;
    for (const phrase of LEAD) {
      if (toks.length > phrase.length && startsWith(toks, phrase)) {
        toks = toks.slice(phrase.length);
        again = true;
        break;
      }
    }
  }
  for (let again = true; again && toks.length > 1; ) {
    again = false;
    for (const phrase of TRAIL) {
      const at = toks.length - phrase.length;
      if (at > 0 && startsWith(toks, phrase, at)) {
        toks = toks.slice(0, at);
        again = true;
        break;
      }
    }
  }
  if (toks.length > 1) {
    const phrase = DELETE_PHRASES.find((p) => toks.length > p.length && startsWith(toks, p));
    if (phrase) toks = [{ ...toks[0], key: 'delete' }, ...toks.slice(phrase.length)];
    else if (DELETE_WORDS.has(toks[0].key)) toks = [{ ...toks[0], key: 'delete' }, ...toks.slice(1)];
    // "take the last sentence out", "take that out"
    else if (toks[0].key === 'take' && toks.at(-1)?.key === 'out' && toks.length > 3) toks = [{ ...toks[0], key: 'delete' }, ...toks.slice(1, -1)];
  }
  // "the last line" is the last sentence; "para" is short for paragraph.
  return toks.map((t, i) => {
    if (t.key === 'para') return { ...t, key: 'paragraph' };
    if (t.key === 'line' && i > 0 && /^(last|final|first|second|third|fourth|fifth|that|this)$/.test(toks[i - 1].key)) return { ...t, key: 'sentence' };
    return t;
  });
}

export interface ParseOptions {
  /** Said to Scribe by name (or in conversation mode): looser phrasings count too. */
  addressed?: boolean;
}

export function parseCommand(input: HeardWord[] | string, options: ParseOptions = {}): Command | null {
  const toks = simplify(tokens(input));
  if (!toks.length || toks.length > 80) return null;
  const text = toks.map((t) => t.key).join(' ');

  for (const r of options.addressed ? [...RULES, ...CASUAL_RULES] : RULES) {
    const m = r.re.exec(text);
    if (!m) continue;
    // Map a matched group back to the original words it covers.
    const slice = (group: string): Tok[] => {
      const span = m.indices?.groups?.[group];
      if (!span) return [];
      const first = text.slice(0, span[0]).split(' ').length - 1;
      const count = text.slice(span[0], span[1]).split(' ').length;
      return toks.slice(first, first + count);
    };
    const command = r.build((m.groups ?? {}) as Groups, slice);
    if (command) return command;
  }
  return null;
}

// Words that open a request to change the essay, including the casual ones above.
const EDIT_WORDS = /^(delete|remove|erase|scratch|cut|insert|add|put|move|replace|change|swap|shift|undo|redo|take|strike|scrap|nix|kill|nuke|ditch|trash|axe?|zap|wipe|lose|drop|toss|chop|dump|yeet|clear|bin|throw|cross|revert|reverse|restore|undelete|bring|forget|oops|whoops|back)$/;

/**
 * Could this request change the essay? Such requests are always heard with the
 * exact transcriber. Polite or filler words in front are skipped ("okay, can
 * you just delete ..."); a question that merely contains such a word ("should
 * I cut the line about the notebook?") is not one.
 */
export function mayChangeEssay(heard: HeardWord[]): boolean {
  const first = simplify(tokens(heard))[0];
  return !!first && EDIT_WORDS.test(first.key);
}
