/**
 * Scribe's grading rubric and the arithmetic that turns section levels into a
 * score out of 100. The rubric is written down in full so the same essay is
 * judged against the same words every time. The numbers are added up in code.
 *
 * This is Scribe's own rubric. It is not any college's scoring system.
 */

export const RUBRIC_VERSION = 'r1';

export type SectionId = 'prompt' | 'voice' | 'detail' | 'structure' | 'insight' | 'mechanics';

export interface Section {
  id: SectionId;
  name: string;
  asks: string;
  /** What each band looks like, weakest first. Levels 1-2, 3-4, 5-6, 7-8, 9-10. */
  anchors: [string, string, string, string, string];
}

export const SECTIONS: Section[] = [
  {
    id: 'prompt',
    name: 'Answers the prompt',
    asks: 'Does the essay answer every part of the question that was asked?',
    anchors: [
      'Does not address the prompt, or answers a different question.',
      'Touches the topic but leaves most parts of the prompt unanswered.',
      'Answers the main part of the prompt; one part is missing or only implied.',
      'Answers every part of the prompt clearly; one part is thinner than the rest.',
      'Answers every part of the prompt fully and directly, and stays on it throughout.',
    ],
  },
  {
    id: 'voice',
    name: 'Authenticity and voice',
    asks: 'Does it sound like one real person, in their own words?',
    anchors: [
      'Reads as generic or borrowed; no sense of who is speaking.',
      'Mostly stock phrases and formal filler; the writer appears only briefly.',
      'A real person is present, but the voice slips into cliché or résumé language in places.',
      'A consistent, natural voice; a few lines could have been written by anyone.',
      'Unmistakably one person throughout; plain, confident and free of cliché.',
    ],
  },
  {
    id: 'detail',
    name: 'Specificity and detail',
    asks: 'Are there concrete moments, names, numbers and actions rather than general claims?',
    anchors: [
      'Only general statements; nothing a reader could picture.',
      'One or two concrete details among mostly general claims.',
      'Some specific moments, but key claims are still told rather than shown.',
      'Most claims are backed by a specific moment, action or detail.',
      'Vivid and precise throughout; every important claim rests on something concrete.',
    ],
  },
  {
    id: 'structure',
    name: 'Structure and flow',
    asks: 'Is it easy to follow from start to finish, with each part earning its place?',
    anchors: [
      'No clear order; ideas appear at random.',
      'A rough order, but paragraphs or sentences jump or repeat.',
      'A clear beginning, middle and end; some transitions are abrupt or a section drags.',
      'Well ordered and easy to follow; one part could be tighter.',
      'Every part leads to the next; the opening and ending both do real work.',
    ],
  },
  {
    id: 'insight',
    name: 'Insight and reflection',
    asks: 'Does the writer show what the experience meant and how they think or changed?',
    anchors: [
      'Events only; no reflection at all.',
      'Reflection is a single stock lesson stated at the end.',
      'Some real reflection, but it stays general or is only stated, not shown.',
      'Clear, personal reflection tied to specific moments in the essay.',
      'Reflection is specific, earned by the story, and shows how the writer thinks now.',
    ],
  },
  {
    id: 'mechanics',
    name: 'Mechanics',
    asks: 'Are spelling, grammar and punctuation correct? (Deliberate style choices are not errors.)',
    anchors: [
      'Errors in most sentences make it hard to read.',
      'Frequent errors that distract the reader.',
      'Several errors, but the meaning is always clear.',
      'One or two small slips.',
      'Clean: no errors a careful reader would notice.',
    ],
  },
];

export type Weights = Record<SectionId, number>;

/** Scribe's default emphasis. Editable per college in the admin screen. */
export const DEFAULT_WEIGHTS: Weights = { prompt: 25, voice: 20, detail: 20, structure: 10, insight: 15, mechanics: 10 };

/** A short answer has little room for structure, so its weight moves to answering the question. */
export const SHORT_ANSWER_WORDS = 200;

export interface WeightChoice {
  weights: Weights;
  /** Plain words saying where the weights came from. */
  source: string;
}

/**
 * The weights used for one essay: the college's own if set, else the default;
 * then the short-answer adjustment; then "Answers the prompt" is dropped when
 * there is no prompt to answer. The result always adds up to 100.
 */
export function chooseWeights(collegeWeights: Partial<Weights> | undefined, collegeName: string | undefined, wordLimit: number | null, hasPrompt: boolean): WeightChoice {
  const custom = collegeWeights && SECTIONS.every((s) => Number.isFinite(collegeWeights[s.id]) && collegeWeights[s.id]! >= 0);
  const w: Weights = custom ? { ...(collegeWeights as Weights) } : { ...DEFAULT_WEIGHTS };
  const notes = [custom ? `Weights set for ${collegeName ?? 'this college'}` : 'Default weights'];
  if (!custom && wordLimit !== null && wordLimit <= SHORT_ANSWER_WORDS) {
    w.prompt += 5;
    w.structure -= 5;
    notes.push(`short answer (${wordLimit} words or fewer): less weight on structure`);
  }
  if (!hasPrompt) {
    w.prompt = 0;
    notes.push('no prompt set, so “Answers the prompt” is not scored');
  }
  return { weights: normalise(w), source: notes.join('; ') + '.' };
}

/** Scale weights to whole numbers that add up to exactly 100. */
export function normalise(w: Weights): Weights {
  const total = SECTIONS.reduce((n, s) => n + Math.max(0, w[s.id]), 0);
  if (total <= 0) return { ...DEFAULT_WEIGHTS };
  const exact = SECTIONS.map((s) => ({ id: s.id, value: (Math.max(0, w[s.id]) * 100) / total }));
  const out = Object.fromEntries(exact.map((e) => [e.id, Math.floor(e.value)])) as Weights;
  // Hand the leftover points to the largest remainders, in rubric order on ties.
  let left = 100 - SECTIONS.reduce((n, s) => n + out[s.id], 0);
  for (const e of [...exact].sort((a, b) => (b.value % 1) - (a.value % 1))) {
    if (left <= 0) break;
    if (e.value > 0) {
      out[e.id]++;
      left--;
    }
  }
  return out;
}

export interface SectionScore {
  id: SectionId;
  /** 1-10 from the rubric bands. */
  level: number;
  /** level x 10. */
  score: number;
  weight: number;
  /** A line of the essay, word for word, that the level rests on. null if the model gave none that checks out. */
  quote: string | null;
  reason: string;
}

/** The band (0-4) a level falls in. */
export const bandOf = (level: number) => Math.min(4, Math.max(0, Math.ceil(level / 2) - 1));

/** Weighted total out of 100, computed in code from the section levels. */
export function totalScore(sections: Pick<SectionScore, 'level' | 'weight'>[]): number {
  const weight = sections.reduce((n, s) => n + s.weight, 0);
  if (weight === 0) return 0;
  return Math.round(sections.reduce((n, s) => n + s.level * 10 * s.weight, 0) / weight);
}

/** One section as the model reads it: what it asks, and every band. */
export function sectionText(s: Section): string {
  return [`${s.id} — ${s.name}: ${s.asks}`, ...s.anchors.map((a, i) => `  levels ${i * 2 + 1}-${i * 2 + 2}: ${a}`)].join('\n');
}

/** The whole rubric, for the sections that are scored. */
export function rubricText(weights: Weights): string {
  return SECTIONS.filter((s) => weights[s.id] > 0).map(sectionText).join('\n\n');
}
