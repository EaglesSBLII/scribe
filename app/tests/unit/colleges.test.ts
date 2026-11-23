import { describe, expect, it } from 'vitest';
import seed from '../../src/colleges/seed.json';
import { collegeNotes, promptsFor, rubricsFor } from '../../src/colleges/store';
import type { CollegeRow, PrincipleRow, PromptRow, RubricRow } from '../../src/db/schema';

const colleges = seed.colleges as CollegeRow[];
const prompts = seed.prompts as PromptRow[];
const rubrics = seed.rubrics as RubricRow[];
const principles = seed.principles as PrincipleRow[];
const college = (id: string) => colleges.find((c) => c.id === id)!;

const official = (url: string) => {
  const { protocol, hostname } = new URL(url);
  return protocol === 'https:' && (hostname.endsWith('.edu') || hostname.endsWith('commonapp.org'));
};

describe('the seeded college database', () => {
  it('has the schools the brief asked for', () => {
    const ids = colleges.map((c) => c.id);
    for (const id of [
      'commonapp', 'uc', 'uc-berkeley', 'uc-davis', 'uc-irvine', 'ucla', 'uc-merced', 'uc-riverside', 'uc-san-diego',
      'uc-santa-barbara', 'uc-santa-cruz', 'penn', 'columbia', 'uchicago', 'uiuc', 'uw', 'penn-state',
    ]) expect(ids, id).toContain(id);
  });

  it('gives every entry a cycle year, and every prompt a source address', () => {
    for (const c of colleges) expect(c.cycleYear, c.id).toMatch(/^\d{4}-\d{2}$/);
    for (const p of prompts) {
      expect(p.cycleYear, p.id).toMatch(/^\d{4}-\d{2}$/);
      expect(p.text.trim().length, p.id).toBeGreaterThan(10);
      expect(official(p.sourceUrl), `${p.id} ${p.sourceUrl}`).toBe(true);
    }
    for (const r of rubrics) expect(official(r.sourceUrl), r.id).toBe(true);
  });

  it('never calls something verified without an official source', () => {
    for (const c of colleges) if (c.verified) expect(official(c.wantsSourceUrl), c.id).toBe(true);
    for (const p of principles) if (p.verified) expect(official(p.sourceUrl), p.id).toBe(true);
  });

  it('marks what could not be confirmed as unverified, with the reason', () => {
    const unverified = colleges.filter((c) => !c.verified);
    expect(unverified.map((c) => c.id).sort()).toEqual(['uc-davis', 'uc-merced', 'uc-santa-cruz', 'uiuc']);
    for (const c of unverified) expect(c.notes, c.id).toBeTruthy();
    // Nothing was filled in for a school whose pages could not be read.
    expect(college('uiuc').wants).toBe('');
    expect(promptsFor(college('uiuc'), prompts)).toEqual([]);
    expect(college('uc-merced').wants).toBe('');
  });

  it('has the Common App prompts with their limits and the eight UC questions', () => {
    const common = promptsFor(college('commonapp'), prompts);
    expect(common).toHaveLength(7);
    for (const p of common) expect([p.minWords, p.wordLimit], p.id).toEqual([250, 650]);
    const piqs = promptsFor(college('uc'), prompts);
    expect(piqs.map((p) => p.id)).toEqual([1, 2, 3, 4, 5, 6, 7, 8].map((n) => `uc-piq-${n}`));
    for (const p of piqs) expect(p.wordLimit).toBe(350);
  });

  it('gives all nine UC campuses the shared questions and the published review factors', () => {
    const campuses = colleges.filter((c) => c.promptsFrom === 'uc');
    expect(campuses).toHaveLength(9);
    for (const c of campuses) {
      expect(promptsFor(c, prompts), c.id).toHaveLength(8);
      expect(rubricsFor(c, rubrics).map((r) => r.id), c.id).toContain('uc-comprehensive-review');
    }
    expect(rubrics.find((r) => r.id === 'uc-comprehensive-review')!.criteria).toHaveLength(13);
  });

  it('lists shared prompts first, then the school\'s own', () => {
    const uw = promptsFor(college('uw'), prompts);
    expect(uw.slice(0, 7).every((p) => p.collegeId === 'commonapp')).toBe(true);
    expect(uw.at(-1)!.collegeId).toBe('uw');
  });

  it('stores short principles with sources, not sample essays', () => {
    expect(principles.length).toBeGreaterThanOrEqual(10);
    for (const p of principles) {
      expect(p.text.split(/\s+/).length, p.id).toBeLessThanOrEqual(30);
      expect(p.sourceName, p.id).toBeTruthy();
    }
    // Paraphrased notes stay short; nothing in the seed is long enough to be a copied essay.
    for (const c of colleges) expect(c.wants.split(/\s+/).length, c.id).toBeLessThanOrEqual(70);
    for (const r of rubrics) for (const k of r.criteria) expect(k.description.split(/\s+/).length, r.id).toBeLessThanOrEqual(40);
  });

  it('has no duplicate ids and no dangling links', () => {
    for (const list of [colleges, prompts, rubrics, principles]) {
      const ids = list.map((x) => x.id);
      expect(new Set(ids).size).toBe(ids.length);
    }
    const known = new Set(colleges.map((c) => c.id));
    for (const p of prompts) expect(known.has(p.collegeId), p.id).toBe(true);
    for (const r of rubrics) expect(known.has(r.collegeId), r.id).toBe(true);
  });
});

describe('what the counselor is told about a school', () => {
  it('labels unverified information so it is not presented as fact', () => {
    const c: CollegeRow = { ...college('penn'), verified: false };
    const notes = collegeNotes(c, rubrics, []);
    expect(notes).toContain('UNVERIFIED');
    expect(collegeNotes(college('penn'), rubrics, [])).not.toContain('UNVERIFIED');
  });

  it('includes published criteria by name and only verified principles', () => {
    const notes = collegeNotes(college('uc-berkeley'), rubrics, [
      { id: 'a', text: 'Use your own voice.', sourceName: 'UC', sourceUrl: 'https://x.edu', verified: true },
      { id: 'b', text: 'Unchecked claim.', sourceName: '?', sourceUrl: '', verified: false },
    ]);
    expect(notes).toContain('UC comprehensive review factors');
    expect(notes).toContain('Use your own voice. (UC)');
    expect(notes).not.toContain('Unchecked claim');
  });

  it('says nothing about a school when none is chosen', () => {
    expect(collegeNotes(undefined, rubrics, [])).toBe('');
  });
});
