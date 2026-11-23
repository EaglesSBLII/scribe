/** Puts the pieces together for one essay: the profile, the lines that stand out, and the notes for the counselor. */
import { docText } from '../doc/types';
import type { EssayRow, MemoryRow } from '../db/schema';
import { computeProfile, voiceOutliers, type Outlier, type Profile } from './profile';
import { memoryNotes } from './store';

export interface Voice {
  profile: Profile;
  outliers: Outlier[];
  /** Text for the counselor; empty when memory is off or there is nothing to say. */
  notes: string;
}

/**
 * `brainstorm` is what the student said while brainstorming: their spoken
 * voice, which counts as their writing for this purpose.
 */
export function buildVoice(essays: EssayRow[], current: EssayRow, rows: MemoryRow[], enabled: boolean, brainstorm: string[] = []): Voice {
  const writing = [...essays.map((e) => docText(e.doc)), ...brainstorm].filter((t) => t.trim());
  const words = (kind: MemoryRow['kind']) => rows.filter((r) => r.kind === kind).map((r) => r.text);
  const profile = computeProfile(writing, { excluded: words('excluded-word'), added: words('word') });
  if (!enabled) return { profile, outliers: [], notes: '' };
  const outliers = voiceOutliers(current.doc, profile, writing);
  return { profile, outliers, notes: memoryNotes(profile, rows, outliers, current.id) };
}
