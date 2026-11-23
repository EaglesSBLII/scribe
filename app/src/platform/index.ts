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
  transcribe(wav: ArrayBuffer): Promise<Transcript>;
  /** Names of the models Ollama has on this machine; empty when it is not running. */
  llmModels(): Promise<string[]>;
  /** Unload the model so its next request starts cold. Used before grading, for repeatable scores. */
  llmUnload(model: string): Promise<void>;
  /** Resolves with the whole reply; `onDelta` gets it piece by piece. */
  llmChat(request: ChatRequest, onDelta?: (text: string) => void, signal?: AbortSignal): Promise<string>;
}

declare global {
  interface Window {
    scribeBridge?: {
      asrAvailable(): Promise<boolean>;
      asrTranscribe(wav: ArrayBuffer): Promise<Transcript>;
      llmModels(): Promise<string[]>;
      llmUnload(model: string): Promise<boolean>;
      llmChat(id: string, request: ChatRequest): Promise<string>;
      llmAbort(id: string): void;
      onLlmDelta(listener: (id: string, text: string) => void): () => void;
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
  async transcribe(wav) {
    const res = await fetch('/api/asr', { method: 'POST', headers: { 'Content-Type': 'audio/wav' }, body: wav });
    if (!res.ok) throw new Error((await res.json().catch(() => null))?.error ?? 'Speech engine failed.');
    return res.json();
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
    transcribe: (wav) => bridge.asrTranscribe(wav),
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
