/**
 * The one place the app reaches outside the page. In the desktop app it goes
 * through the preload bridge; in the browser it goes to the local helper on
 * 127.0.0.1. Same idea as Chilaka's PlatformBridge.
 */
import type { HeardWord } from '../dictation/clean';

export interface Transcript {
  text: string;
  words: HeardWord[];
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
    };
  }
}

const ERROR_MARK = '\n\u0000ERROR ';

const web: PlatformBridge = {
  kind: 'web',
  async asrAvailable() {
    try {
      const res = await fetch('/api/health');
      return res.ok && (await res.json()).asr === true;
    } catch {
      return false;
    }
  },
  async session() {
    try {
      const res = await fetch('/api/session');
      if (res.ok) return (await res.json()) as Session;
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
