/** Per-account settings, stored locally. */
import { create } from 'zustand';
import { db } from './db/schema';

export const DEFAULT_MODEL = 'qwen3.5:9b';

interface SettingsState {
  accountId: string | null;
  llmModel: string;
  load(accountId: string): Promise<void>;
  setModel(model: string): Promise<void>;
}

export const useSettings = create<SettingsState>((set, get) => ({
  accountId: null,
  llmModel: DEFAULT_MODEL,
  async load(accountId) {
    const row = await db.settings.get([accountId, 'llmModel']);
    set({ accountId, llmModel: typeof row?.value === 'string' ? row.value : DEFAULT_MODEL });
  },
  async setModel(model) {
    const { accountId } = get();
    set({ llmModel: model });
    if (accountId) await db.settings.put({ accountId, key: 'llmModel', value: model });
  },
}));
