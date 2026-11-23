/** Paper formats learned from uploaded samples, kept per account in the local database. */
import { create } from 'zustand';
import { db } from '../db/schema';
import { learnFromFile } from './learn';
import type { FormatProfile } from './layout';

export interface SampleRow {
  id: string;
  accountId: string;
  fileName: string;
  learnedAt: number;
  format: FormatProfile;
}

interface PaperState {
  accountId: string | null;
  samples: SampleRow[];
  busy: boolean;
  error: string | null;
  load(accountId: string): Promise<void>;
  /** Learn a format from a PDF or DOCX. Returns its id, or null if it could not be read. */
  learn(file: File): Promise<string | null>;
  remove(id: string): Promise<void>;
}

export const usePaper = create<PaperState>((set, get) => ({
  accountId: null,
  samples: [],
  busy: false,
  error: null,

  async load(accountId) {
    const samples = (await db.table<SampleRow>('samples').where('accountId').equals(accountId).toArray()).sort((a, b) => a.learnedAt - b.learnedAt);
    set({ accountId, samples, error: null });
  },

  async learn(file) {
    const { accountId } = get();
    if (!accountId || get().busy) return null;
    set({ busy: true, error: null });
    try {
      const format = await learnFromFile(file);
      // Only the formatting is stored; the sample's text is not kept.
      const row: SampleRow = { id: format.id, accountId, fileName: file.name, learnedAt: Date.now(), format };
      await db.table<SampleRow>('samples').put(row);
      set({ samples: [...get().samples, row] });
      return row.id;
    } catch (err) {
      set({ error: err instanceof Error ? err.message : 'That file could not be read.' });
      return null;
    } finally {
      set({ busy: false });
    }
  },

  async remove(id) {
    await db.table('samples').delete(id);
    set({ samples: get().samples.filter((s) => s.id !== id) });
  },
}));
