/** Per-account settings, stored locally. */
import { create } from 'zustand';
import { db } from './db/schema';

export const DEFAULT_MODEL = 'qwen3.5:9b';
/** A small, fast model for turning a spoken request into a command. */
export const DEFAULT_COMMAND_MODEL = 'qwen3.5:4b';

/** How much the counselor speaks up. */
export type CounselorMode = 'draft' | 'coach' | 'conversation';

interface Values {
  llmModel: string;
  commandModel: string;
  /** Keep the microphone open and wait for "Jarvis". */
  wakeWord: boolean;
  /** 0 to 1. */
  earconVolume: number;
  /** Ids of cues that are switched off. */
  earconsOff: string[];
  /** The counselor answers out loud. */
  speakReplies: boolean;
  voice: string;
}

const DEFAULTS: Values = {
  llmModel: DEFAULT_MODEL,
  commandModel: DEFAULT_COMMAND_MODEL,
  wakeWord: false,
  earconVolume: 0.6,
  earconsOff: [],
  speakReplies: true,
  voice: 'af_heart',
};

interface SettingsState extends Values {
  accountId: string | null;
  load(accountId: string): Promise<void>;
  set<K extends keyof Values>(key: K, value: Values[K]): Promise<void>;
  setModel(model: string): Promise<void>;
}

export const useSettings = create<SettingsState>((set, get) => ({
  accountId: null,
  ...DEFAULTS,

  async load(accountId) {
    const rows = await db.settings.where('[accountId+key]').between([accountId, ''], [accountId, '￿']).toArray();
    const stored: Partial<Values> = {};
    for (const row of rows) {
      if (row.key in DEFAULTS && typeof row.value === typeof DEFAULTS[row.key as keyof Values]) {
        (stored as Record<string, unknown>)[row.key] = row.value;
      }
    }
    set({ accountId, ...DEFAULTS, ...stored });
  },

  async set(key, value) {
    const { accountId } = get();
    set({ [key]: value } as Partial<SettingsState>);
    if (accountId) await db.settings.put({ accountId, key, value });
  },

  setModel: (model) => get().set('llmModel', model),
}));
