/**
 * The student's voice, measured from their own writing. Everything here is
 * counted in code: how long their sentences run, which words they keep coming
 * back to, and which lines in a draft do not sound like the rest.
 */
import { sentences } from '../doc/segment';
import { paraText, type Doc } from '../doc/types';

export interface Profile {
  /** False until there is enough writing to say anything. */
  ready: boolean;
  wordCount: number;
  sentenceCount: number;
  /** Words per sentence. */
  meanLength: number;
  medianLength: number;
  /** Share of sentences of 8 words or fewer, 0-1. */
  shortShare: number;
  /** Share of sentences of 25 words or more, 0-1. */
  longShare: number;
  /** Contractions per 100 words ("didn't", "I'd"). */
  contractionRate: number;
  /** Words the student uses again and again, most used first. */
  vocabulary: { word: string; count: number }[];
  /** A few of their own sentences that show their usual pattern. */
  typicalLines: string[];
}

export const MIN_WORDS_FOR_PROFILE = 120;
export const MIN_SENTENCES_FOR_PROFILE = 8;

const STOPWORDS = new Set(
  `a about above after again against all also am an and any are aren't as at be because been before being below between both but by can
can't cannot could couldn't did didn't do does doesn't doing don't down during each even ever every few for from further get got had hadn't
has hasn't have haven't having he he'd he'll he's her here here's hers herself him himself his how how's i i'd i'll i'm i've if in into is
isn't it it's its itself just let's like made make many may me more most much my myself never no nor not now of off on once one only or
other our ours ourselves out over own same she she'd she'll she's should shouldn't so some still such than that that's the their theirs
them themselves then there there's these they they'd they'll they're they've thing things this those though through time to too two under
until up us very was wasn't way we we'd we'll we're we've well were weren't what what's when when's where where's which while who who's
whom why why's will with won't would wouldn't year years you you'd you'll you're you've your yours yourself yourselves said say says
back first last long new old right day days went go going come came took take know knew think thought want wanted really always
around away something anything everything nothing someone because since without within another`.split(/\s+/),
);

/** Stock essay words. Flagged only when they are not otherwise part of the student's vocabulary. */
const STOCK_WORDS = [
  'plethora', 'myriad', 'utilize', 'utilized', 'furthermore', 'moreover', 'thus', 'hence', 'tapestry', 'testament', 'delve', 'delved',
  'multifaceted', 'invaluable', 'endeavor', 'endeavors', 'paramount', 'pivotal', 'foster', 'fostered', 'cultivate', 'cultivated',
  'profound', 'profoundly', 'embark', 'embarked', 'realm', 'instilled', 'aforementioned', 'nevertheless', 'whilst', 'transformative',
];

const tokens = (text: string) => text.toLowerCase().replace(/’/g, "'").match(/[\p{L}][\p{L}']*/gu) ?? [];
const lengthOf = (sentence: string) => (sentence.match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu) ?? []).length;

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

const round1 = (n: number) => Math.round(n * 10) / 10;

export interface ProfileOptions {
  /** Words the student said are not theirs. */
  excluded?: string[];
  /** Words the student added by hand. */
  added?: string[];
}

/** Build the profile from pieces of the student's own writing (essays, brainstorm answers). */
export function computeProfile(texts: string[], opts: ProfileOptions = {}): Profile {
  const all: string[] = [];
  for (const text of texts) for (const para of text.split(/\n+/)) all.push(...sentences(para).map((s) => s.text));
  const lengths = all.map(lengthOf).filter((n) => n > 0);
  const words = texts.flatMap(tokens);
  const wordCount = lengths.reduce((a, b) => a + b, 0);

  const counts = new Map<string, number>();
  for (const w of words) if (w.length > 2 && !STOPWORDS.has(w)) counts.set(w, (counts.get(w) ?? 0) + 1);
  const excluded = new Set((opts.excluded ?? []).map((w) => w.toLowerCase()));
  const vocabulary = [...counts.entries()]
    .filter(([word, count]) => count >= 3 && !excluded.has(word))
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 24)
    .map(([word, count]) => ({ word, count }));
  for (const word of opts.added ?? []) {
    const w = word.toLowerCase().trim();
    if (w && !vocabulary.some((v) => v.word === w)) vocabulary.push({ word: w, count: counts.get(w) ?? 0 });
  }

  const mean = lengths.length ? wordCount / lengths.length : 0;
  const med = median(lengths);
  const shortShare = lengths.length ? lengths.filter((n) => n <= 8).length / lengths.length : 0;
  // Lines that show the usual pattern: near the typical length, or short ones for a writer who favours short lines.
  const target = shortShare >= 0.35 ? Math.min(med, 8) : med;
  const typicalLines = [...new Set(all)]
    .filter((s) => lengthOf(s) >= 3)
    .sort((a, b) => Math.abs(lengthOf(a) - target) - Math.abs(lengthOf(b) - target) || a.localeCompare(b))
    .slice(0, 3);

  return {
    ready: wordCount >= MIN_WORDS_FOR_PROFILE && lengths.length >= MIN_SENTENCES_FOR_PROFILE,
    wordCount,
    sentenceCount: lengths.length,
    meanLength: round1(mean),
    medianLength: round1(med),
    shortShare: round1(shortShare * 100) / 100,
    longShare: lengths.length ? round1((lengths.filter((n) => n >= 25).length / lengths.length) * 100) / 100 : 0,
    contractionRate: wordCount ? round1((words.filter((w) => /\p{L}'\p{L}/u.test(w)).length / wordCount) * 100) : 0,
    vocabulary,
    typicalLines,
  };
}

export interface Outlier {
  /** "P2·S3" */
  where: string;
  text: string;
  /** Plain words, addressed to the student. */
  why: string;
}

/**
 * Lines in a draft that sound less like the student than the rest of their
 * writing: much longer than their usual sentence, or leaning on stock essay
 * words they do not otherwise use.
 */
export function voiceOutliers(doc: Doc, profile: Profile, allWriting: string[]): Outlier[] {
  if (!profile.ready) return [];
  const usage = new Map<string, number>();
  for (const w of allWriting.flatMap(tokens)) usage.set(w, (usage.get(w) ?? 0) + 1);
  const longLimit = Math.max(25, Math.round(profile.meanLength * 2));
  const out: Outlier[] = [];
  doc.paragraphs.forEach((p, pi) => {
    sentences(paraText(p)).forEach((s, si) => {
      const reasons: string[] = [];
      const n = lengthOf(s.text);
      if (n >= longLimit) reasons.push(`it runs ${n} words, and your usual sentence is about ${Math.round(profile.meanLength)}`);
      const stock = [...new Set(tokens(s.text))].filter((w) => STOCK_WORDS.includes(w) && (usage.get(w) ?? 0) <= 1);
      if (stock.length) reasons.push(`it uses ${stock.map((w) => `“${w}”`).join(' and ')}, which you do not use anywhere else`);
      if (reasons.length) out.push({ where: `P${pi + 1}·S${si + 1}`, text: s.text, why: `Sounds less like you: ${reasons.join('; ')}.` });
    });
  });
  return out.slice(0, 6);
}

/** One line describing the rhythm, in plain words. */
export function describeRhythm(p: Profile): string {
  const short = Math.round(p.shortShare * 100);
  const long = Math.round(p.longShare * 100);
  const lean = short >= 35 ? 'You favour short sentences.' : long >= 30 ? 'You favour long sentences.' : 'You mix short and long sentences.';
  return `Your sentences average ${p.meanLength} words (middle value ${p.medianLength}). ${short}% are 8 words or fewer and ${long}% are 25 or more. ${lean}`;
}
