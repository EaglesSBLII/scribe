/**
 * The two final checks that need judgement: does the essay answer the prompt,
 * and are there typos. The model only reports; every quote it gives is checked
 * against the essay, and anything it cannot back with the essay's words is dropped.
 */
import { platform } from '../platform';
import { useSettings } from '../settings';
import { docText } from '../doc/types';
import { essayContext, type EssayView } from './prompts';
import { isVerbatim } from './guard';

export interface JudgedChecks {
  /** null when no prompt is set, so there was nothing to compare against. */
  answersPrompt: { verdict: 'yes' | 'partly' | 'no'; why: string; quote: string | null } | null;
  typos: { quote: string; issue: string }[];
}

export async function judgedChecks(essay: EssayView): Promise<JudgedChecks> {
  const text = docText(essay.doc);
  const hasPrompt = essay.promptText.trim().length > 0;
  const raw = await platform.llmChat({
    model: useSettings.getState().llmModel,
    options: { temperature: 0, seed: 7 },
    format: {
      type: 'object',
      required: ['verdict', 'why', 'quote', 'typos'],
      properties: {
        verdict: { type: 'string', enum: ['yes', 'partly', 'no'] },
        why: { type: 'string' },
        quote: { type: 'string' },
        typos: {
          type: 'array',
          items: { type: 'object', required: ['quote', 'issue'], properties: { quote: { type: 'string' }, issue: { type: 'string' } } },
        },
      },
    },
    messages: [
      {
        role: 'system',
        content:
          'You are proofreading a finished college essay. Report only; never rewrite. Answer in JSON with: "verdict" (does the essay answer its prompt: yes, partly or no), "why" (one or two sentences to the student), "quote" (the one line of the essay, copied exactly, that best shows your verdict), and "typos" (a list of real spelling, grammar or punctuation mistakes; for each give "quote", the few words containing the mistake copied EXACTLY from the essay, and "issue", a short description of what is wrong, without writing the corrected text). Style choices, sentence fragments used on purpose and informal voice are not mistakes. If there are no mistakes, return an empty list.',
      },
      { role: 'user', content: essayContext(essay) },
    ],
  });
  const data = JSON.parse(raw) as { verdict?: string; why?: string; quote?: string; typos?: { quote?: string; issue?: string }[] };
  const verdict = data.verdict === 'yes' || data.verdict === 'partly' || data.verdict === 'no' ? data.verdict : 'partly';
  return {
    answersPrompt: hasPrompt
      ? { verdict, why: String(data.why ?? '').trim(), quote: data.quote && isVerbatim(data.quote, text) ? data.quote.trim() : null }
      : null,
    typos: (data.typos ?? [])
      .filter((t): t is { quote: string; issue: string } => typeof t.quote === 'string' && typeof t.issue === 'string')
      .filter((t) => isVerbatim(t.quote, text))
      .map((t) => ({ quote: t.quote.trim(), issue: t.issue.trim() })),
  };
}
