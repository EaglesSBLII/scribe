/**
 * Rubric-based grading. The model reads the essay against the written rubric
 * and returns a level and a quoted line for each section. Everything else is
 * done in code: checking each quote against the essay, the weighted total, and
 * remembering the result so the same draft always gets the same score.
 */
import { create } from 'zustand';
import { db, type GradeRow } from '../db/schema';
import { platform, type ChatMessage } from '../platform';
import { useSettings } from '../settings';
import { docText } from '../doc/types';
import { countWords } from '../doc/segment';
import { RUBRIC_VERSION, SECTIONS, sectionText, totalScore, type Section, type SectionId, type SectionScore, type Weights } from '../grading/rubric';
import { numberedEssay, type EssayView } from './prompts';
import { isVerbatim } from './guard';

export const MIN_WORDS_TO_GRADE = 50;

/** A stable fingerprint of everything that decides a grade. */
export async function gradeKey(text: string, promptText: string, weights: Weights, model: string): Promise<string> {
  const input = JSON.stringify([RUBRIC_VERSION, model, promptText.trim(), SECTIONS.map((s) => weights[s.id]), text]);
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

type RawSections = Partial<Record<SectionId, { level?: unknown; quote?: unknown; reason?: unknown }>>;

/** Turn the model's answer into checked section scores. Pure, so it can be tested without a model. */
export function readSections(raw: RawSections, essayText: string, weights: Weights): { sections: SectionScore[]; badQuotes: SectionId[] } {
  const sections: SectionScore[] = [];
  const badQuotes: SectionId[] = [];
  for (const s of SECTIONS) {
    if (weights[s.id] <= 0) continue;
    const got = raw[s.id] ?? {};
    const level = Math.min(10, Math.max(1, Math.round(Number(got.level) || 1)));
    const cleaned = typeof got.quote === 'string' ? cleanQuote(got.quote) : '';
    const quote = cleaned && isVerbatim(cleaned, essayText) ? cleaned : null;
    if (!quote) badQuotes.push(s.id);
    sections.push({ id: s.id, level, score: level * 10, weight: weights[s.id], quote, reason: typeof got.reason === 'string' ? got.reason.trim() : '' });
  }
  return { sections, badQuotes };
}

/** The model sometimes copies the line label along with the line; the label is not part of the essay. */
export function cleanQuote(quote: string): string {
  return quote.replace(/\[P\d+·S\d+\]\s*/g, '').trim();
}

const SYSTEM = `You grade a college application essay against a fixed rubric, one rubric section at a time. Be consistent and literal: judge only what is on the page, against the band descriptions. Do not inflate a level, and do not mark one down without a reason you can point to in the essay.

For the section you are given, answer with:
- "level": a whole number from 1 to 10. First pick the band whose description fits best, then the lower or upper number in that band.
- "quote": ONE line copied exactly, word for word, from the ESSAY, that best supports your level. It must be one of the essay's labelled lines, never part of the prompt. Leave out the [P1·S1] label and do not change any word.
- "reason": one sentence to the student saying why this level, referring to that line.

Do not rewrite or suggest wording. Answer in JSON only.`;

const ANSWER = {
  type: 'object',
  required: ['level', 'quote', 'reason'],
  properties: { level: { type: 'integer', minimum: 1, maximum: 10 }, quote: { type: 'string' }, reason: { type: 'string' } },
};

type RawSection = { level?: unknown; quote?: unknown; reason?: unknown };

/**
 * One section, one request. Each section is judged from the same starting
 * point (the essay and that section's bands), so the wording the model chose
 * for an earlier section cannot nudge a later one. The level is the first
 * thing it writes.
 */
async function askSection(view: EssayView, section: Section, model: string, previous?: string): Promise<RawSection> {
  const messages: ChatMessage[] = [
    { role: 'system', content: SYSTEM },
    {
      role: 'user',
      content: [
        `PROMPT THE ESSAY MUST ANSWER\n${view.promptText.trim() || '(none set)'}`,
        `ESSAY (one labelled sentence per line)\n${numberedEssay(view.doc)}`,
      ].join('\n\n'),
    },
    { role: 'user', content: `SECTION TO GRADE\n${sectionText(section)}` },
  ];
  if (previous) {
    messages.push(
      { role: 'assistant', content: previous },
      { role: 'user', content: 'That quote is not an exact line from the ESSAY section (it must not come from the prompt). Answer again with the same level, and copy one of the essay\'s labelled lines word for word, without its label.' },
    );
  }
  // Temperature 0, a fixed seed and top-1 sampling, to make the same input give the same output.
  const raw = await platform.llmChat({ model, messages, format: ANSWER, options: { temperature: 0, seed: 7, top_k: 1 } });
  return JSON.parse(raw) as RawSection;
}

/** Grade every scored section. A second try may supply a better quote, but never changes a level. */
async function askAll(view: EssayView, weights: Weights, model: string, essayText: string): Promise<RawSections> {
  const out: RawSections = {};
  for (const section of SECTIONS) {
    if (weights[section.id] <= 0) continue;
    const first = await askSection(view, section, model);
    out[section.id] = first;
    const usable = (a: RawSection) => typeof a.quote === 'string' && isVerbatim(cleanQuote(a.quote), essayText);
    if (usable(first)) continue;
    const second = await askSection(view, section, model, JSON.stringify(first));
    if (usable(second)) out[section.id] = { ...first, quote: second.quote };
  }
  return out;
}

export interface GradeRequest extends EssayView {
  id: string;
  weights: Weights;
  weightsSource: string;
}

interface GradesState {
  essayId: string | null;
  /** Oldest first. */
  history: GradeRow[];
  busy: boolean;
  error: string | null;
  /** True when the last result came from the stored grade for identical text. */
  reused: boolean;
  load(essayId: string): Promise<void>;
  grade(request: GradeRequest): Promise<GradeRow | null>;
}

export const useGrades = create<GradesState>((set, get) => ({
  essayId: null,
  history: [],
  busy: false,
  error: null,
  reused: false,

  async load(essayId) {
    set({ essayId, history: await db.grades.where('essayId').equals(essayId).sortBy('ts'), error: null, reused: false });
  },

  async grade(request) {
    if (get().busy) return null;
    const text = docText(request.doc);
    const words = countWords(text);
    if (words < MIN_WORDS_TO_GRADE) {
      set({ error: `Write at least ${MIN_WORDS_TO_GRADE} words before grading (${words} so far).` });
      return null;
    }
    set({ busy: true, error: null, reused: false });
    try {
      const model = useSettings.getState().llmModel;
      const key = await gradeKey(text, request.promptText, request.weights, model);
      // The same draft, prompt, weights, model and rubric: return the grade already given.
      const existing = await db.grades.where('textHash').equals(key).and((g) => g.essayId === request.id).first();
      if (existing) {
        set({ reused: true });
        return existing;
      }

      // Start from a cold model. Ollama reuses work from earlier requests, and the
      // amount it reuses shifts the answer; a fixed starting state removes that.
      await platform.llmUnload(model);
      const read = readSections(await askAll(request, request.weights, model, text), text, request.weights);

      const row: GradeRow = {
        essayId: request.id, textHash: key, ts: Date.now(), total: totalScore(read.sections), sections: read.sections,
        weightsSource: request.weightsSource, model, rubricVersion: RUBRIC_VERSION, wordCount: words,
      };
      row.id = await db.grades.add(row);
      if (get().essayId === request.id) set((s) => ({ history: [...s.history, row] }));
      return row;
    } catch (err) {
      set({ error: err instanceof Error ? err.message : 'Grading failed.' });
      return null;
    } finally {
      set({ busy: false });
    }
  },
}));
