/** Per-account settings, stored locally. */
import { create } from 'zustand';
import { db } from './db/schema';

export const DEFAULT_MODEL = 'qwen3.5:9b';
/**
 * The model that turns a spoken request into a command. Empty means "the
 * counselor's model", so only one model is held in memory; a smaller one can
 * be chosen in Settings.
 */
export const DEFAULT_COMMAND_MODEL = '';

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
  counselorMode: CounselorMode;
  /** Talking over Scribe stops it. When off, the microphone is ignored while Scribe speaks. */
  bargeIn: boolean;
}

const DEFAULTS: Values = {
  llmModel: DEFAULT_MODEL,
  commandModel: DEFAULT_COMMAND_MODEL,
  wakeWord: false,
  earconVolume: 0.6,
  earconsOff: [],
  speakReplies: true,
  voice: 'af_bella',
  counselorMode: 'draft',
  bargeIn: true,
};

interface SettingsState extends Values {
  accountId: string | null;
  /** The settings screen is showing. */
  screenOpen: boolean;
  setScreenOpen(open: boolean): void;
  load(accountId: string): Promise<void>;
  set<K extends keyof Values>(key: K, value: Values[K]): Promise<void>;
  setModel(model: string): Promise<void>;
}

export const useSettings = create<SettingsState>((set, get) => ({
  accountId: null,
  screenOpen: false,
  setScreenOpen: (screenOpen) => set({ screenOpen }),
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
