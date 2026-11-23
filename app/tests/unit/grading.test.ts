import { describe, expect, it } from 'vitest';
import {
  bandOf, chooseWeights, DEFAULT_WEIGHTS, normalise, rubricText, SECTIONS, totalScore, type Weights,
} from '../../src/grading/rubric';
import { gradeKey, readSections } from '../../src/llm/grader';

const essay = 'The summer I turned sixteen, I rebuilt a boat engine with my grandfather. It did not start. He laughed and said the mistake was in the notebook.';
const sum = (w: Weights) => SECTIONS.reduce((n, s) => n + w[s.id], 0);

describe('the written rubric', () => {
  it('has the six default sections, each with an anchor for every band', () => {
    expect(SECTIONS.map((s) => s.name)).toEqual([
      'Answers the prompt', 'Authenticity and voice', 'Specificity and detail', 'Structure and flow', 'Insight and reflection', 'Mechanics',
    ]);
    for (const s of SECTIONS) {
      expect(s.anchors).toHaveLength(5);
      for (const a of s.anchors) expect(a.length, s.id).toBeGreaterThan(20);
    }
    expect(sum(DEFAULT_WEIGHTS)).toBe(100);
  });

  it('maps levels to bands', () => {
    expect([1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map(bandOf)).toEqual([0, 0, 1, 1, 2, 2, 3, 3, 4, 4]);
  });

  it('shows the model every band of every scored section, and leaves out unscored ones', () => {
    const text = rubricText(DEFAULT_WEIGHTS);
    expect(text.match(/levels \d+-\d+:/g)).toHaveLength(30);
    expect(rubricText({ ...DEFAULT_WEIGHTS, prompt: 0 })).not.toContain('Answers the prompt');
  });
});

describe('weights', () => {
  it('uses the defaults when the college has none', () => {
    const c = chooseWeights(undefined, undefined, 650, true);
    expect(c.weights).toEqual(DEFAULT_WEIGHTS);
    expect(c.source).toBe('Default weights.');
  });

  it('uses the weights set for the college, scaled to 100', () => {
    const c = chooseWeights({ prompt: 4, voice: 2, detail: 2, structure: 1, insight: 1, mechanics: 0 }, 'Test U', 650, true);
    expect(c.weights).toEqual({ prompt: 40, voice: 20, detail: 20, structure: 10, insight: 10, mechanics: 0 });
    expect(c.source).toContain('Weights set for Test U');
  });

  it('moves weight from structure to the prompt for short answers', () => {
    const c = chooseWeights(undefined, undefined, 150, true);
    expect(c.weights.prompt).toBe(30);
    expect(c.weights.structure).toBe(5);
    expect(sum(c.weights)).toBe(100);
  });

  it('does not score "Answers the prompt" when there is no prompt', () => {
    const c = chooseWeights(undefined, undefined, null, false);
    expect(c.weights.prompt).toBe(0);
    expect(sum(c.weights)).toBe(100);
    expect(c.source).toContain('no prompt set');
  });

  it('always adds up to exactly 100', () => {
    for (const w of [
      { prompt: 1, voice: 1, detail: 1, structure: 1, insight: 1, mechanics: 1 },
      { prompt: 7, voice: 3, detail: 3, structure: 0, insight: 0, mechanics: 0 },
      { prompt: 33, voice: 33, detail: 33, structure: 1, insight: 1, mechanics: 1 },
    ]) expect(sum(normalise(w))).toBe(100);
  });
});

describe('the score is computed in code', () => {
  it('is the weighted average of the section levels', () => {
    const sections = SECTIONS.map((s, i) => ({ level: [8, 6, 7, 5, 4, 9][i], weight: DEFAULT_WEIGHTS[s.id] }));
    // (80*25 + 60*20 + 70*20 + 50*10 + 40*15 + 90*10) / 100 = 66
    expect(totalScore(sections)).toBe(66);
    expect(totalScore(SECTIONS.map((s) => ({ level: 10, weight: DEFAULT_WEIGHTS[s.id] })))).toBe(100);
    expect(totalScore(SECTIONS.map((s) => ({ level: 1, weight: DEFAULT_WEIGHTS[s.id] })))).toBe(10);
  });
});

describe('reading the model\'s answer', () => {
  const raw = {
    prompt: { level: 7, quote: 'It did not start.', reason: 'Names the setback.' },
    voice: { level: 8, quote: 'he laughed and said the mistake was in the notebook', reason: 'Sounds like you.' },
    detail: { level: 12, quote: 'I rebuilt a boat engine with my grandfather', reason: 'Concrete.' },
    structure: { level: 'six', quote: 'It did not start.', reason: 'Clear order.' },
    insight: { level: 4, quote: 'I learned that failure builds character', reason: 'Stated.' },
    mechanics: { level: 9, quote: '', reason: 'Clean.' },
  };

  it('keeps quotes that are word for word in the essay and rejects the rest', () => {
    const { sections, badQuotes } = readSections(raw, essay, DEFAULT_WEIGHTS);
    expect(sections.find((s) => s.id === 'prompt')!.quote).toBe('It did not start.');
    expect(sections.find((s) => s.id === 'voice')!.quote).toBeTruthy();
    // An invented line and an empty one are not accepted as evidence.
    expect(sections.find((s) => s.id === 'insight')!.quote).toBeNull();
    expect(badQuotes).toEqual(['insight', 'mechanics']);
  });

  it('clamps levels to 1-10 and skips sections with no weight', () => {
    const { sections } = readSections(raw, essay, { ...DEFAULT_WEIGHTS, mechanics: 0 });
    expect(sections.map((s) => s.id)).not.toContain('mechanics');
    expect(sections.find((s) => s.id === 'detail')!.level).toBe(10);
    expect(sections.find((s) => s.id === 'structure')!.level).toBe(1);
    for (const s of sections) expect(s.score).toBe(s.level * 10);
  });
});

describe('the fingerprint that makes re-grading repeatable', () => {
  it('is the same for the same text, prompt, weights and model', async () => {
    const a = await gradeKey(essay, 'Prompt', DEFAULT_WEIGHTS, 'qwen3.5:9b');
    expect(await gradeKey(essay, 'Prompt', { ...DEFAULT_WEIGHTS }, 'qwen3.5:9b')).toBe(a);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it('changes when anything that affects the grade changes', async () => {
    const a = await gradeKey(essay, 'Prompt', DEFAULT_WEIGHTS, 'qwen3.5:9b');
    expect(await gradeKey(essay + ' More.', 'Prompt', DEFAULT_WEIGHTS, 'qwen3.5:9b')).not.toBe(a);
    expect(await gradeKey(essay, 'Other prompt', DEFAULT_WEIGHTS, 'qwen3.5:9b')).not.toBe(a);
    expect(await gradeKey(essay, 'Prompt', { ...DEFAULT_WEIGHTS, voice: 21, detail: 19 }, 'qwen3.5:9b')).not.toBe(a);
    expect(await gradeKey(essay, 'Prompt', DEFAULT_WEIGHTS, 'llama3.1:8b')).not.toBe(a);
  });
});
