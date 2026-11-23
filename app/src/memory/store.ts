/**
 * Personal memory for one account: what Scribe has learned about how the
 * student writes. Stored only in the local database, and fully in the
 * student's hands: every item can be seen, changed or deleted.
 */
import { create } from 'zustand';
import { db, type MemoryRow } from '../db/schema';
import { describeVoice, type VoiceSource } from '../llm/voice';
import { describeRhythm, type Outlier, type Profile } from './profile';

interface MemoryState {
  accountId: string | null;
  /** When off, nothing is learned and nothing remembered is used. */
  enabled: boolean;
  rows: MemoryRow[];
  busy: boolean;
  error: string | null;
  screenOpen: boolean;

  load(accountId: string): Promise<void>;
  setScreenOpen(open: boolean): void;
  setEnabled(enabled: boolean): Promise<void>;
  add(row: Omit<MemoryRow, 'id' | 'accountId' | 'ts'>): Promise<void>;
  update(id: string, patch: Partial<Pick<MemoryRow, 'text' | 'verdict'>>): Promise<void>;
  remove(id: string): Promise<void>;
  /** Mark a piece of counselor advice as useful or not; marking again changes it. */
  rateFeedback(text: string, verdict: 'accepted' | 'rejected', essayId: string, essayTitle: string): Promise<void>;
  /** Ask the local model for fresh tone notes and the stories each essay tells. */
  refreshFromWriting(sources: VoiceSource[]): Promise<void>;
  deleteAll(): Promise<void>;
}

export const useMemory = create<MemoryState>((set, get) => ({
  accountId: null,
  enabled: true,
  rows: [],
  busy: false,
  error: null,
  screenOpen: false,

  async load(accountId) {
    const [rows, setting] = await Promise.all([
      db.memory.where('accountId').equals(accountId).sortBy('ts'),
      db.settings.get([accountId, 'memoryEnabled']),
    ]);
    set({ accountId, rows, enabled: setting?.value !== false, error: null });
  },

  setScreenOpen: (screenOpen) => set({ screenOpen }),

  async setEnabled(enabled) {
    const { accountId } = get();
    set({ enabled });
    if (accountId) await db.settings.put({ accountId, key: 'memoryEnabled', value: enabled });
  },

  async add(row) {
    const { accountId } = get();
    if (!accountId) return;
    const full: MemoryRow = { ...row, id: crypto.randomUUID(), accountId, ts: Date.now() };
    set({ rows: [...get().rows, full] });
    await db.memory.add(full);
  },

  async update(id, patch) {
    const current = get().rows.find((r) => r.id === id);
    if (!current) return;
    const next = { ...current, ...patch };
    set({ rows: get().rows.map((r) => (r.id === id ? next : r)) });
    await db.memory.put(next);
  },

  async remove(id) {
    set({ rows: get().rows.filter((r) => r.id !== id) });
    await db.memory.delete(id);
  },

  async rateFeedback(text, verdict, essayId, essayTitle) {
    if (!get().enabled) return;
    const existing = get().rows.find((r) => r.kind === 'feedback' && r.text === text);
    if (existing) return get().update(existing.id, { verdict });
    await get().add({ kind: 'feedback', text, verdict, essayId, essayTitle, source: 'you' });
  },

  async refreshFromWriting(sources) {
    const { accountId, busy, enabled } = get();
    if (!accountId || busy || !enabled) return;
    set({ busy: true, error: null });
    try {
      const notes = await describeVoice(sources);
      if (notes.tone.length === 0 && notes.stories.length === 0) {
        return set({ error: 'There is not enough writing yet to describe your voice. Write a little more and try again.' });
      }
      const now = Date.now();
      const fresh: MemoryRow[] = [
        ...notes.tone.map((t, i): MemoryRow => ({ id: crypto.randomUUID(), accountId, kind: 'tone', text: t.text, quote: t.quote, source: 'model', ts: now + i })),
        ...notes.stories.map((s, i): MemoryRow => ({
          id: crypto.randomUUID(), accountId, kind: 'story', text: s.text, quote: s.quote, essayId: s.essayId, essayTitle: s.essayTitle, source: 'model', ts: now + 100 + i,
        })),
      ];
      // Notes the model wrote before are replaced; anything the student wrote or edited by hand stays.
      const stale = get().rows.filter((r) => r.source === 'model' && (r.kind === 'tone' || r.kind === 'story'));
      await db.transaction('rw', db.memory, async () => {
        await db.memory.bulkDelete(stale.map((r) => r.id));
        await db.memory.bulkAdd(fresh);
      });
      set({ rows: [...get().rows.filter((r) => !stale.includes(r)), ...fresh] });
    } catch (err) {
      set({ error: err instanceof Error ? err.message : 'Could not describe your voice.' });
    } finally {
      set({ busy: false });
    }
  },

  async deleteAll() {
    const { accountId } = get();
    if (!accountId) return;
    set({ rows: [] });
    await db.memory.where('accountId').equals(accountId).delete();
  },
}));

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);

/**
 * What the counselor is told about the student's own voice. The instruction is
 * to strengthen that voice, never to move it toward a generic style.
 */
export function memoryNotes(profile: Profile, rows: MemoryRow[], outliers: Outlier[], currentEssayId: string): string {
  const lines: string[] = [];
  if (profile.ready) {
    lines.push(describeRhythm(profile).replace(/\bYour\b/g, 'Their').replace(/\bYou\b/g, 'They').replace(/\bfavour\b/g, 'favour'));
    if (profile.vocabulary.length) lines.push(`Words they keep using: ${profile.vocabulary.slice(0, 14).map((v) => v.word).join(', ')}.`);
    if (profile.typicalLines.length) lines.push(`Lines typical of them: ${profile.typicalLines.map((l) => `"${clip(l, 110)}"`).join(' / ')}`);
  }
  const of = (kind: MemoryRow['kind']) => rows.filter((r) => r.kind === kind);
  const tone = of('tone').slice(-6);
  if (tone.length) lines.push(`How they write: ${tone.map((t) => clip(t.text, 90)).join('; ')}.`);
  const used = of('story').filter((s) => s.essayId !== currentEssayId).slice(-6);
  if (used.length) {
    lines.push(`Stories already used in their OTHER essays (warn them if this essay repeats one): ${used.map((s) => `${clip(s.text, 50)} (in "${clip(s.essayTitle ?? 'another essay', 40)}")`).join('; ')}.`);
  }
  const accepted = of('feedback').filter((f) => f.verdict === 'accepted').slice(-4);
  const rejected = of('feedback').filter((f) => f.verdict === 'rejected').slice(-4);
  if (accepted.length) lines.push(`Advice they found useful before: ${accepted.map((f) => `"${clip(f.text, 120)}"`).join(' / ')}`);
  if (rejected.length) lines.push(`Advice they rejected (do not give it again): ${rejected.map((f) => `"${clip(f.text, 120)}"`).join(' / ')}`);
  if (outliers.length) {
    lines.push(`Lines in this essay that differ from their usual style (measured): ${outliers.map((o) => `${o.where} ${o.why.replace(/^Sounds less like you: /, '').replace(/\byour\b/g, 'their').replace(/\byou\b/g, 'they')}`).join(' | ')}`);
  }
  if (lines.length === 0) return '';
  return [
    'THE STUDENT\'S OWN VOICE (learned from their writing):',
    ...lines.map((l) => `- ${l}`),
    'Use this to strengthen THEIR voice. When a line sounds unlike them, say so and point to one of their own lines that sounds like them. Never push them toward a more formal, polished or generic style, and never suggest vocabulary they do not use.',
  ].join('\n');
}
