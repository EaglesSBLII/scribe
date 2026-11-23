import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { computeProfile, describeRhythm, voiceOutliers } from '../../src/memory/profile';
import { memoryNotes } from '../../src/memory/store';
import { buildVoice } from '../../src/memory/voice';
import { textToNodes, type Doc } from '../../src/doc/types';
import type { EssayRow, MemoryRow } from '../../src/db/schema';

const read = (n: number) => readFileSync(new URL(`../fixtures/essays/essay${n}.txt`, import.meta.url), 'utf8').trim();
const doc = (...paras: string[]): Doc => ({ paragraphs: paras.map((text, i) => ({ id: `p${i + 1}`, nodes: textToNodes(text) })) });
const essay = (id: string, title: string, text: string): EssayRow => ({
  id, accountId: 'acct', title, collegeId: null, promptId: null, stage: 'refine', order: 0, archived: false, wordCount: 0, createdAt: 0, updatedAt: 0,
  doc: doc(...text.split(/\n\s*\n/)),
});
const row = (kind: MemoryRow['kind'], text: string, extra: Partial<MemoryRow> = {}): MemoryRow => ({
  id: `${kind}-${text}`, accountId: 'acct', kind, text, source: 'you', ts: 0, ...extra,
});

// A writer of short, plain sentences.
const short = [
  'The engine did not start. He laughed. I did not.',
  'We drained the tank. We started again. It took eleven days.',
  'My hands smelled of fuel. The notebook was wrong. I had copied it.',
  'The engine was old. The notebook was new. I trusted the notebook.',
];

describe('measuring the voice', () => {
  it('needs enough writing before it says anything', () => {
    expect(computeProfile(['Too short.']).ready).toBe(false);
    expect(computeProfile([read(1)]).ready).toBe(true);
  });

  it('measures sentence rhythm', () => {
    const p = computeProfile(short);
    expect(p.sentenceCount).toBe(12);
    expect(p.meanLength).toBeLessThan(5);
    expect(p.shortShare).toBe(1);
    expect(p.longShare).toBe(0);
    expect(describeRhythm({ ...p, ready: true })).toContain('You favour short sentences.');
  });

  it('is deterministic: the same writing gives the same profile', () => {
    expect(computeProfile([read(1), read(2)])).toEqual(computeProfile([read(1), read(2)]));
  });

  it('finds the words the student keeps coming back to, and skips everyday words', () => {
    const words = computeProfile(short).vocabulary.map((v) => v.word);
    // "notebook" is used four times; "engine" only twice, which is not yet a habit.
    expect(words).toEqual(['notebook']);
    expect(words).not.toContain('the');
    expect(words).not.toContain('did');
  });

  it('respects words the student removed or added', () => {
    const p = computeProfile(short, { excluded: ['notebook'], added: ['Boatyard'] });
    const words = p.vocabulary.map((v) => v.word);
    expect(words).not.toContain('notebook');
    expect(words).toContain('boatyard');
  });

  it('offers lines of theirs that show the usual pattern', () => {
    const p = computeProfile(short);
    expect(p.typicalLines).toHaveLength(3);
    for (const line of p.typicalLines) expect(short.join(' ')).toContain(line);
  });

  it('counts contractions', () => {
    expect(computeProfile(["I didn't go. I'd stayed. It wasn't late."]).contractionRate).toBeGreaterThan(20);
  });
});

describe('lines that sound less like the student', () => {
  const profile = { ...computeProfile(short), ready: true };

  it('flags a sentence far longer than their usual', () => {
    const long = 'Throughout the entirety of that long and difficult summer I slowly came to appreciate that the process of repairing an engine teaches patience and humility in equal measure.';
    const found = voiceOutliers(doc('The engine did not start.', long), profile, [...short, long]);
    expect(found).toHaveLength(1);
    expect(found[0].where).toBe('P2·S1');
    expect(found[0].why).toMatch(/^Sounds less like you: it runs \d+ words, and your usual sentence is about \d+\.$/);
  });

  it('flags stock essay words the student does not otherwise use', () => {
    const found = voiceOutliers(doc('I learned a plethora of lessons.'), profile, [...short, 'I learned a plethora of lessons.']);
    expect(found[0].why).toContain('“plethora”, which you do not use anywhere else');
  });

  it('does not flag a word that is part of how they write', () => {
    const habit = ['Thus it began.', 'Thus we waited.', 'Thus I learned.'];
    expect(voiceOutliers(doc('Thus it ended.'), profile, [...short, ...habit, 'Thus it ended.'])).toEqual([]);
  });

  it('flags nothing in writing that matches their own style, or before the profile is ready', () => {
    expect(voiceOutliers(doc(short[0], short[1]), profile, short)).toEqual([]);
    expect(voiceOutliers(doc('Any plethora at all.'), computeProfile(['Tiny.']), ['Tiny.'])).toEqual([]);
  });
});

describe('what the counselor is told', () => {
  const profile = { ...computeProfile(short), ready: true };
  const rows = [
    row('tone', 'Ends paragraphs on a short flat line', { source: 'model', quote: 'I did not.' }),
    row('story', 'Rebuilding the engine', { essayId: 'other', essayTitle: 'Common App' }),
    row('story', 'The dishwasher shift', { essayId: 'this', essayTitle: 'This essay' }),
    row('feedback', 'Name the sound the engine made.', { verdict: 'accepted' }),
    row('feedback', 'Open with a quotation.', { verdict: 'rejected' }),
  ];
  const notes = memoryNotes(profile, rows, [], 'this');

  it('describes the voice and tells the model to strengthen it, not replace it', () => {
    expect(notes).toContain('They favour short sentences.');
    expect(notes).toContain('Words they keep using: notebook.');
    expect(notes).toContain('Ends paragraphs on a short flat line');
    expect(notes).toContain('Never push them toward a more formal, polished or generic style');
  });

  it('lists stories from other essays only, and both kinds of feedback', () => {
    expect(notes).toContain('Rebuilding the engine (in "Common App")');
    expect(notes).not.toContain('The dishwasher shift');
    expect(notes).toContain('Advice they found useful before: "Name the sound the engine made."');
    expect(notes).toContain('Advice they rejected (do not give it again): "Open with a quotation."');
  });

  it('says nothing when there is nothing to say', () => {
    expect(memoryNotes(computeProfile(['Tiny.']), [], [], 'this')).toBe('');
  });
});

describe('memory switched off', () => {
  const essays = [essay('a', 'One', read(1)), essay('b', 'Two', read(2))];
  const rows = [row('tone', 'Dry humour', { source: 'model' })];

  it('uses nothing when off, and everything when on', () => {
    expect(buildVoice(essays, essays[0], rows, false).notes).toBe('');
    expect(buildVoice(essays, essays[0], rows, false).outliers).toEqual([]);
    const on = buildVoice(essays, essays[0], rows, true);
    expect(on.profile.ready).toBe(true);
    expect(on.notes).toContain('Dry humour');
  });

  it('counts what was said while brainstorming as the student\'s voice', () => {
    const quiet = buildVoice([essay('c', 'Three', 'Short.')], essay('c', 'Three', 'Short.'), [], true);
    const spoken = buildVoice([essay('c', 'Three', 'Short.')], essay('c', 'Three', 'Short.'), [], true, short);
    expect(quiet.profile.ready).toBe(false);
    expect(spoken.profile.sentenceCount).toBe(13);
  });
});
