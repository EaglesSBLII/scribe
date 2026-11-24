/**
 * The one place the app reaches outside the page. In the desktop app it goes
 * through the preload bridge; in the browser it goes to the local helper on
 * 127.0.0.1. Same idea as Chilaka's PlatformBridge.
 */
import type { HeardWord } from '../dictation/clean';

export interface Transcript {
  text: string;
  words: HeardWord[];
  /** How sure Whisper was that this was speech at all. */
  quality?: { noSpeech: number; logprob: number };
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  /** A JSON schema the reply must follow, for labelled answers. */
  format?: unknown;
  options?: { temperature?: number; seed?: number; top_k?: number; num_predict?: number };
}

export interface PlatformBridge {
  kind: 'desktop' | 'web';
  asrAvailable(): Promise<boolean>;
  /** `quick` trades a little accuracy for speed; never used for words that go into the essay. */
  transcribe(wav: ArrayBuffer, quick?: boolean): Promise<Transcript>;
  /** Names of the models Ollama has on this machine; empty when it is not running. */
  llmModels(): Promise<string[]>;
  /** Unload the model so its next request starts cold. Used before grading, for repeatable scores. */
  llmUnload(model: string): Promise<void>;
  /** Resolves with the whole reply; `onDelta` gets it piece by piece. */
  llmChat(request: ChatRequest, onDelta?: (text: string) => void, signal?: AbortSignal): Promise<string>;
  /** The local voice: whether it is installed, and the voices it has. */
  ttsInfo(): Promise<{ available: boolean; voices: string[]; defaultVoice: string }>;
  /** One sentence as a WAV file, synthesized on this machine. */
  ttsSpeak(text: string, voice: string, speed?: number): Promise<ArrayBuffer>;
  /** Whether this page is on the Mac itself, or on another device that must sign in. */
  session(): Promise<Session>;
  login(email: string, password: string): Promise<string>;
  logout(): Promise<void>;
  /** One sync round with the master copy on the Mac. Rejects when the Mac cannot be reached. */
  syncExchange(body: SyncRequest): Promise<SyncResponse>;
  /** Phone access for an account: switched on by setting a password, on the Mac only. */
  remoteStatus(email: string): Promise<{ enabled: boolean }>;
  remoteSet(email: string, password: string): Promise<{ enabled: boolean }>;
  remoteDisable(email: string): Promise<{ enabled: boolean }>;
  /** App updates. Only the Mac app has this; in a browser there is nothing to update. */
  updater?: UpdaterBridge;
}

export type UpdatePhase = 'idle' | 'checking' | 'up-to-date' | 'available' | 'downloading' | 'ready' | 'error';

/** What the Mac app's updater reports (desktop/src/updater.js). */
export interface UpdateState {
  phase: UpdatePhase;
  /** The new version, once one is known. */
  version?: string;
  notes?: string;
  /** Bytes, while downloading. */
  size?: number;
  received?: number;
  /** 0 to 100 while downloading. */
  percent?: number;
  /** In plain words, when phase is 'error'. */
  error?: string;
}

export interface UpdaterBridge {
  state(): Promise<UpdateState>;
  /** `enabled` is false in a development run, where nothing is checked. */
  info(): Promise<{ enabled: boolean; current: string; auto: boolean }>;
  check(): Promise<void>;
  download(): Promise<void>;
  /** Swap in the downloaded version and restart. */
  install(): Promise<void>;
  setAuto(on: boolean): Promise<boolean>;
  onState(listener: (state: UpdateState) => void): () => void;
}

export type Session = { local: true } | { local: false; signedIn: boolean; email: string | null };

export interface SyncRecord {
  coll: string;
  key: string;
  value: unknown;
  updatedAt: number;
  deleted?: boolean;
  rev?: number;
}
export interface SyncRequest {
  email: string;
  since: number;
  push: SyncRecord[];
}
export interface SyncResponse {
  rev: number;
  pull: SyncRecord[];
  accepted: string[];
}

/** The Mac could not be reached at all (as opposed to answering with an error). */
export class Unreachable extends Error {}

async function call<T>(path: string, method: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, { method, body: body === undefined ? undefined : JSON.stringify(body) });
  } catch {
    throw new Unreachable('The Mac cannot be reached.');
  }
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error(data?.error ?? 'That did not work.');
  return data as T;
}

declare global {
  interface Window {
    scribeBridge?: {
      asrAvailable(): Promise<boolean>;
      asrTranscribe(wav: ArrayBuffer, quick?: boolean): Promise<Transcript>;
      llmModels(): Promise<string[]>;
      llmUnload(model: string): Promise<boolean>;
      ttsInfo(): Promise<{ available: boolean; voices: string[]; defaultVoice: string }>;
      ttsSpeak(text: string, voice: string, speed?: number): Promise<ArrayBuffer>;
      llmChat(id: string, request: ChatRequest): Promise<string>;
      llmAbort(id: string): void;
      onLlmDelta(listener: (id: string, text: string) => void): () => void;
      syncExchange?(body: SyncRequest): Promise<SyncResponse>;
      remoteStatus?(email: string): Promise<{ enabled: boolean }>;
      remoteSet?(email: string, password: string): Promise<{ enabled: boolean; error?: string }>;
      remoteDisable?(email: string): Promise<{ enabled: boolean }>;
      updater?: UpdaterBridge;
    };
  }
}

const ERROR_MARK = '\n\u0000ERROR ';

let unreachable = false;
/** The last check of the speech engine got no answer at all (a phone away from its Mac). */
export const macUnreachable = () => unreachable;

const web: PlatformBridge = {
  kind: 'web',
  async asrAvailable() {
    let res: Response;
    try {
      res = await fetch('/api/health');
    } catch {
      // No answer at all: the Mac is out of reach, which is different from "no speech engine".
      unreachable = true;
      return false;
    }
    unreachable = false;
    try {
      return res.ok && (await res.json()).asr === true;
    } catch {
      return false;
    }
  },
  async session() {
    try {
      const res = await fetch('/api/session');
      if (res.ok) return (await res.json()) as Session;
      // Refused: this is another device and the Mac has not let it in (phone access is off).
      if (res.status === 401 || res.status === 403) return { local: false, signedIn: false, email: null };
    } catch { /* offline, or opened without the helper: this device's own copy is used */ }
    return { local: true };
  },
  login: async (email, password) => (await call<{ email: string }>('/api/login', 'POST', { email, password })).email,
  logout: async () => void (await call('/api/logout', 'POST', {}).catch(() => {})),
  syncExchange: (body) => call<SyncResponse>('/api/sync', 'POST', body),
  remoteStatus: (email) => call<{ enabled: boolean }>(`/api/remote?email=${encodeURIComponent(email)}`, 'GET'),
  remoteSet: (email, password) => call<{ enabled: boolean }>('/api/remote', 'POST', { email, password }),
  remoteDisable: (email) => call<{ enabled: boolean }>('/api/remote', 'DELETE', { email }),
  async transcribe(wav, quick) {
    let res: Response;
    try {
      res = await fetch(quick ? '/api/asr?quick=1' : '/api/asr', { method: 'POST', headers: { 'Content-Type': 'audio/wav' }, body: wav });
    } catch {
      throw new Unreachable('The Mac cannot be reached.');
    }
    if (!res.ok) throw new Error((await res.json().catch(() => null))?.error ?? 'Speech engine failed.');
    return res.json();
  },
  async ttsInfo() {
    try {
      const health = await (await fetch('/api/health')).json();
      return { available: health.tts === true, voices: health.voices ?? [], defaultVoice: health.defaultVoice ?? 'af_bella' };
    } catch {
      return { available: false, voices: [], defaultVoice: 'af_bella' };
    }
  },
  async ttsSpeak(text, voice, speed) {
    const res = await fetch('/api/tts', { method: 'POST', body: JSON.stringify({ text, voice, speed }) });
    if (!res.ok) throw new Error('The voice is not available.');
    return res.arrayBuffer();
  },
  async llmModels() {
    try {
      const res = await fetch('/api/llm/models');
      return res.ok ? ((await res.json()).models ?? []) : [];
    } catch {
      return [];
    }
  },
  async llmUnload(model) {
    await fetch('/api/llm/unload', { method: 'POST', body: JSON.stringify({ model }) }).catch(() => {});
  },
  async llmChat(request, onDelta, signal) {
    let res: Response;
    try {
      res = await fetch('/api/llm/chat', { method: 'POST', body: JSON.stringify(request), signal });
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') throw err;
      throw new Error('The counselor is not available. Start Scribe with ./setup.sh or npm start.');
    }
    if (!res.ok || !res.body) throw new Error('The counselor is not available. Start Scribe with ./setup.sh or npm start.');
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let full = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const piece = decoder.decode(value, { stream: true });
      full += piece;
      // Hold back anything that might be the start of an error marker.
      if (!full.includes('\u0000')) onDelta?.(piece);
    }
    const failed = full.indexOf(ERROR_MARK);
    if (failed >= 0) throw new Error(full.slice(failed + ERROR_MARK.length));
    return full;
  },
};

function desktop(bridge: NonNullable<Window['scribeBridge']>): PlatformBridge {
  return {
    kind: 'desktop',
    asrAvailable: () => bridge.asrAvailable(),
    ttsInfo: () => bridge.ttsInfo().catch(() => ({ available: false, voices: [], defaultVoice: 'af_bella' })),
    ttsSpeak: (text, voice, speed) => bridge.ttsSpeak(text, voice, speed),
    transcribe: (wav, quick) => bridge.asrTranscribe(wav, quick),
    session: async () => ({ local: true }),
    login: async () => { throw new Error('Signing in is for other devices.'); },
    logout: async () => {},
    syncExchange: (body) => (bridge.syncExchange ? bridge.syncExchange(body) : Promise.reject(new Unreachable('Sync is not available.'))),
    remoteStatus: async (email) => (await bridge.remoteStatus?.(email)) ?? { enabled: false },
    async remoteSet(email, password) {
      const done = await bridge.remoteSet?.(email, password);
      if (!done) throw new Error('Phone access is not available in this build.');
      if (done.error) throw new Error(done.error);
      return done;
    },
    remoteDisable: async (email) => (await bridge.remoteDisable?.(email)) ?? { enabled: false },
    updater: bridge.updater,
    llmModels: () => bridge.llmModels().catch(() => []),
    llmUnload: async (model) => void (await bridge.llmUnload(model).catch(() => false)),
    async llmChat(request, onDelta, signal) {
      const id = crypto.randomUUID();
      const off = bridge.onLlmDelta((from, text) => from === id && onDelta?.(text));
      signal?.addEventListener('abort', () => bridge.llmAbort(id));
      try {
        return await bridge.llmChat(id, request);
      } finally {
        off();
      }
    },
  };
}

const bridge = typeof window === 'undefined' ? undefined : window.scribeBridge;

export const platform: PlatformBridge = bridge ? desktop(bridge) : web;
