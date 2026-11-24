/** The local, editable college database. */
import { create } from 'zustand';
import { db, type CollegeRow, type PrincipleRow, type PromptRow, type RubricRow } from '../db/schema';
import { findUsCollege, ipedsCollegeRow, isIpedsId, loadUsColleges, type UsCollege } from './usColleges';

export const CURRENT_CYCLE = '2026-27';

interface CollegesState {
  ready: boolean;
  adminOpen: boolean;
  colleges: CollegeRow[];
  prompts: PromptRow[];
  rubrics: RubricRow[];
  principles: PrincipleRow[];
  /** Almost every US college by name, city, state and website. Null until it is first needed. */
  us: UsCollege[] | null;

  load(): Promise<void>;
  /** Reads the big list of US colleges, once. */
  loadUs(): Promise<UsCollege[]>;
  /** Puts a school from the big list into the local database, with no prompts and no guidance. */
  addUsCollege(school: UsCollege): CollegeRow;
  /** Fills in schools that essays point at but this device has no row for (essays sync, colleges do not). */
  resolveMissing(ids: readonly (string | null | undefined)[]): Promise<void>;
  setAdminOpen(open: boolean): void;
  saveCollege(row: CollegeRow): Promise<void>;
  deleteCollege(id: string): Promise<void>;
  savePrompt(row: PromptRow): Promise<void>;
  deletePrompt(id: string): Promise<void>;
  saveRubric(row: RubricRow): Promise<void>;
  deleteRubric(id: string): Promise<void>;
  savePrinciple(row: PrincipleRow): Promise<void>;
  deletePrinciple(id: string): Promise<void>;
}

const upsert = <T extends { id: string }>(list: T[], row: T) =>
  list.some((x) => x.id === row.id) ? list.map((x) => (x.id === row.id ? row : x)) : [...list, row];

export const useColleges = create<CollegesState>((set, get) => ({
  ready: false,
  adminOpen: false,
  colleges: [],
  prompts: [],
  rubrics: [],
  principles: [],
  us: null,

  async loadUs() {
    const loaded = get().us;
    if (loaded) return loaded;
    const { rows } = await loadUsColleges();
    set({ us: rows });
    return rows;
  },

  addUsCollege(school) {
    const row = ipedsCollegeRow(school, CURRENT_CYCLE);
    const existing = get().colleges.find((c) => c.id === row.id);
    if (existing) return existing;
    set({ colleges: upsert(get().colleges, row).sort((a, b) => a.name.localeCompare(b.name)) });
    // A copy already stored (and perhaps edited) on this device is never overwritten.
    void db.colleges.add(row).catch(() => {});
    return row;
  },

  async resolveMissing(ids) {
    const missing = () => [...new Set(ids.filter(isIpedsId))].filter((id) => !get().colleges.some((c) => c.id === id));
    if (missing().length === 0) return;
    const us = await get().loadUs();
    for (const id of missing()) {
      const school = findUsCollege(id, us);
      if (school) get().addUsCollege(school);
    }
  },

  async load() {
    const [colleges, prompts, rubrics, principles] = await Promise.all([
      db.colleges.toArray(), db.prompts.toArray(), db.rubrics.toArray(), db.principles.toArray(),
    ]);
    set({ colleges: colleges.sort((a, b) => a.name.localeCompare(b.name)), prompts, rubrics, principles, ready: true });
  },

  setAdminOpen: (adminOpen) => set({ adminOpen }),

  async saveCollege(row) {
    // The screen is updated first, then the database, so the next edit always builds on this one.
    const next = { ...row, edited: true };
    set({ colleges: upsert(get().colleges, next).sort((a, b) => a.name.localeCompare(b.name)) });
    await db.colleges.put(next);
  },

  async deleteCollege(id) {
    await db.transaction('rw', db.colleges, db.prompts, db.rubrics, async () => {
      await db.colleges.delete(id);
      await db.prompts.where('collegeId').equals(id).delete();
      await db.rubrics.where('collegeId').equals(id).delete();
    });
    set({
      colleges: get().colleges.filter((c) => c.id !== id),
      prompts: get().prompts.filter((p) => p.collegeId !== id),
      rubrics: get().rubrics.filter((r) => r.collegeId !== id),
    });
  },

  async savePrompt(row) {
    const next = { ...row, edited: true };
    set({ prompts: upsert(get().prompts, next) });
    await db.prompts.put(next);
  },

  async deletePrompt(id) {
    await db.prompts.delete(id);
    set({ prompts: get().prompts.filter((p) => p.id !== id) });
  },

  async saveRubric(row) {
    const next = { ...row, edited: true };
    set({ rubrics: upsert(get().rubrics, next) });
    await db.rubrics.put(next);
  },

  async deleteRubric(id) {
    await db.rubrics.delete(id);
    set({ rubrics: get().rubrics.filter((r) => r.id !== id) });
  },

  async savePrinciple(row) {
    const next = { ...row, edited: true };
    set({ principles: upsert(get().principles, next) });
    await db.principles.put(next);
  },

  async deletePrinciple(id) {
    await db.principles.delete(id);
    set({ principles: get().principles.filter((p) => p.id !== id) });
  },
}));

/** The prompts a college uses: those of the entry it shares with, then its own. */
export function promptsFor(college: CollegeRow | undefined, prompts: PromptRow[]): PromptRow[] {
  if (!college) return [];
  const byId = (a: PromptRow, b: PromptRow) => a.id.localeCompare(b.id, undefined, { numeric: true });
  return [
    ...prompts.filter((p) => p.collegeId === college.promptsFrom).sort(byId),
    ...prompts.filter((p) => p.collegeId === college.id).sort(byId),
  ];
}

/** Grading weights set for a college, or for the entry it shares prompts with. */
export function gradingWeightsFor(college: CollegeRow | undefined, colleges: CollegeRow[]): { weights?: Record<string, number>; name?: string } {
  if (!college) return {};
  if (college.gradingWeights) return { weights: college.gradingWeights, name: college.name };
  const parent = colleges.find((c) => c.id === college.promptsFrom);
  return parent?.gradingWeights ? { weights: parent.gradingWeights, name: parent.name } : {};
}

/** Published criteria that apply to a college, including those of the entry it shares prompts with. */
export function rubricsFor(college: CollegeRow | undefined, rubrics: RubricRow[]): RubricRow[] {
  if (!college) return [];
  return rubrics.filter((r) => r.collegeId === college.id || r.collegeId === college.promptsFrom);
}

/**
 * What the counselor is told about the school. Anything not confirmed on an
 * official page is labelled so the model does not present it as fact.
 */
export function collegeNotes(
  college: CollegeRow | undefined,
  rubrics: RubricRow[],
  principles: PrincipleRow[],
): string {
  const lines: string[] = [];
  if (college) {
    lines.push(`College: ${college.name} (${college.cycleYear} cycle).`);
    if (college.wants) lines.push(`What the school says it wants${college.verified ? '' : ' (UNVERIFIED, may be out of date)'}: ${college.wants}`);
    const published = rubricsFor(college, rubrics);
    for (const r of published) {
      lines.push(`${r.title}${r.verified ? '' : ' (UNVERIFIED)'}: ${r.criteria.map((c) => c.name).join('; ')}.`);
    }
    // Nothing stored for this school: say so, so the counselor does not fill the gap from memory.
    if (!college.wants && published.length === 0) {
      lines.push('Nothing this school has published about what it looks for is stored here. Do not state or guess what this school wants.');
    }
  }
  const usable = principles.filter((p) => p.verified).slice(0, 8);
  if (usable.length) lines.push('Principles from published admissions guidance:', ...usable.map((p) => `- ${p.text} (${p.sourceName})`));
  return lines.join('\n');
}
