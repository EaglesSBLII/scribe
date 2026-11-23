/**
 * Local database: Dexie over IndexedDB, the same approach as Chilaka.
 * Everything a person writes is keyed to their account id. Nothing leaves this machine.
 */
import Dexie, { type EntityTable, type Table } from 'dexie';
import type { Doc } from '../doc/types';
import type { Op } from '../doc/ops';

export interface AccountRow {
  id: string;
  email: string;
  createdAt: number;
}

export interface MetaRow {
  key: string;
  value: unknown;
}

export interface SettingRow {
  accountId: string;
  key: string;
  value: unknown;
}

export type Stage = 'brainstorm' | 'draft' | 'refine' | 'finish';

export interface EssayRow {
  id: string;
  accountId: string;
  title: string;
  collegeId: string | null;
  promptId: string | null;
  stage: Stage;
  order: number;
  archived: boolean;
  wordCount: number;
  /** Set by hand for now; filled from the chosen prompt once the college database exists. */
  wordLimit?: number | null;
  /** The question the essay answers. Set by choosing a prompt, or typed in. */
  promptText?: string;
  /** Math and physics dictation is on for this essay. */
  mathMode?: boolean;
  /** A paper format learned from an uploaded sample, used on export. */
  formatId?: string | null;
  createdAt: number;
  updatedAt: number;
  doc: Doc;
}

/** One applied edit and how to reverse it. The undo stack is these rows. */
export interface OpRow {
  seq?: number;
  essayId: string;
  ts: number;
  op: Op;
  inverse: Op;
  /** True once the edit has been undone; it can then be redone. */
  undone: boolean;
}

export interface VersionRow {
  id?: number;
  essayId: string;
  ts: number;
  reason: string;
  wordCount: number;
  doc: Doc;
}

/** One line of conversation with the counselor. Never part of the essay. */
export interface ChatRow {
  id?: number;
  essayId: string;
  ts: number;
  role: 'user' | 'assistant';
  text: string;
  stage: Stage;
}

/** A story from brainstorming, in the student's words, rated against the prompt. */
export interface StoryRow {
  id: string;
  accountId: string;
  essayId: string;
  /** A short label written by the model. Shown in the panel only. */
  title: string;
  /** The student's own words, checked to be word for word. */
  quote: string;
  /** 1 (weak fit for the prompt) to 5 (strong fit). */
  fit: number;
  reason: string;
  ts: number;
}

/** Fields every college-database entry carries, so its origin is always visible. */
interface Sourced {
  /** Official page this came from. Empty when there is none. */
  sourceUrl: string;
  /** Application cycle, like "2026-27". */
  cycleYear: string;
  /** False means "unverified": not confirmed on an official page for this cycle. */
  verified: boolean;
  notes?: string;
  /** Changed by the user in the admin screen; seed updates leave it alone. */
  edited?: boolean;
}

export interface CollegeRow extends Omit<Sourced, 'sourceUrl'> {
  id: string;
  name: string;
  appliesVia: string;
  /** Another entry whose prompts this one uses (each UC campus uses the UC entry's). */
  promptsFrom: string | null;
  /** What the school itself says it wants applicants to convey, paraphrased. */
  wants: string;
  wantsSourceUrl: string;
  /** Scribe's grading emphasis for this school, set by the user. Not the school's own scoring. */
  gradingWeights?: Record<string, number>;
}

export interface PromptRow extends Sourced {
  id: string;
  collegeId: string;
  label: string;
  text: string;
  minWords: number | null;
  wordLimit: number | null;
  instructions: string;
}

/** Criteria a school has published. Never filled in by guesswork. */
export interface RubricRow extends Sourced {
  id: string;
  collegeId: string;
  title: string;
  criteria: { name: string; description: string }[];
}

/** A principle of good application essays, from published admissions guidance. */
export interface PrincipleRow {
  id: string;
  text: string;
  sourceName: string;
  sourceUrl: string;
  verified: boolean;
  edited?: boolean;
}

/** One grading of one draft. A draft with the same text is never graded twice. */
export interface GradeRow {
  id?: number;
  essayId: string;
  /** Fingerprint of the text, prompt, weights, model and rubric that produced this grade. */
  textHash: string;
  ts: number;
  total: number;
  sections: { id: string; level: number; score: number; weight: number; quote: string | null; reason: string }[];
  weightsSource: string;
  model: string;
  rubricVersion: string;
  wordCount: number;
}

/**
 * One thing Scribe remembers about the student, tied to their account.
 *  word / excluded-word: vocabulary they added, or said is not theirs
 *  tone: a short note on how they write
 *  story: a story already used in an essay
 *  feedback: counselor advice they marked useful or not for them
 */
export interface MemoryRow {
  id: string;
  accountId: string;
  kind: 'word' | 'excluded-word' | 'tone' | 'story' | 'feedback';
  text: string;
  /** The student's own words this rests on, checked word for word. */
  quote?: string;
  essayId?: string;
  essayTitle?: string;
  verdict?: 'accepted' | 'rejected';
  source: 'you' | 'model';
  ts: number;
}

export class ScribeDB extends Dexie {
  memory!: EntityTable<MemoryRow, 'id'>;
  grades!: EntityTable<GradeRow, 'id'>;
  chats!: EntityTable<ChatRow, 'id'>;
  stories!: EntityTable<StoryRow, 'id'>;
  colleges!: EntityTable<CollegeRow, 'id'>;
  prompts!: EntityTable<PromptRow, 'id'>;
  rubrics!: EntityTable<RubricRow, 'id'>;
  principles!: EntityTable<PrincipleRow, 'id'>;
  accounts!: EntityTable<AccountRow, 'id'>;
  meta!: EntityTable<MetaRow, 'key'>;
  settings!: Table<SettingRow, [string, string]>;
  essays!: EntityTable<EssayRow, 'id'>;
  ops!: EntityTable<OpRow, 'seq'>;
  versions!: EntityTable<VersionRow, 'id'>;

  constructor() {
    super('scribe');
    this.version(1).stores({
      accounts: 'id, &email',
      meta: 'key',
      settings: '[accountId+key]',
      essays: 'id, accountId, [accountId+order]',
      ops: '++seq, essayId',
      versions: '++id, essayId, ts',
      // Used from later build phases; declared now so the schema matches the plan.
      chats: '++id, essayId',
      grades: '++id, essayId, textHash',
      stories: 'id, accountId',
      memory: 'id, accountId, kind',
      colleges: 'id',
      prompts: 'id, collegeId',
      rubrics: 'id, collegeId',
      principles: 'id',
      samples: 'id, accountId',
    });
  }
}

export const db = new ScribeDB();
export const SCHEMA_VERSION = 1;
