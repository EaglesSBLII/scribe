/** Helpers for running recordings through the same code the app uses. */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { Chunker, encodeWav, type ChunkerOptions } from '../../src/dictation/chunker';
import type { HeardWord } from '../../src/dictation/clean';

export const ROOT = path.resolve(import.meta.dirname, '../../..');
export const EVAL_DIR = path.join(ROOT, '.tools', 'wake-eval');

const require = createRequire(import.meta.url);
const { createWhisper } = require(path.join(ROOT, 'local', 'whisper.js')) as {
  createWhisper(dir: string): { start(): Promise<void>; stop(): void; transcribe(wav: Buffer): Promise<{ text: string; words: HeardWord[] }> };
};

export const whisper = createWhisper(path.join(ROOT, 'desktop', 'resources'));

/** 16 kHz mono 16-bit WAV to samples in the range -1..1. */
export function readWav(file: string): Float32Array {
  const bytes = fs.readFileSync(file);
  const at = bytes.subarray(0, 8192).indexOf('data');
  const body = bytes.subarray(at + 8);
  const out = new Float32Array(Math.floor(body.length / 2));
  for (let i = 0; i < out.length; i++) out[i] = body.readInt16LE(i * 2) / 32768;
  return out;
}

export interface Utterance {
  /** Seconds into the recording at which the utterance ended. */
  endsAt: number;
  samples: Float32Array;
}

/** Split a recording into utterances exactly as the live microphone path does. */
export function utterances(samples: Float32Array, opts: ChunkerOptions = {}): Utterance[] {
  const found: Utterance[] = [];
  let fed = 0;
  // (A stretch too quiet to be the speaker arrives empty, and is skipped, as the app does.)
  const chunker = new Chunker({ ...opts, onChunk: (s) => s.length && found.push({ endsAt: fed / 16000, samples: s }) });
  for (let i = 0; i < samples.length; i += 1600) {
    fed = Math.min(samples.length, i + 1600);
    chunker.feed(samples.subarray(i, fed));
  }
  chunker.flush();
  return found;
}

export async function hear(samples: Float32Array): Promise<{ text: string; words: HeardWord[]; ms: number }> {
  const started = performance.now();
  const result = await whisper.transcribe(Buffer.from(encodeWav(samples)));
  return { ...result, ms: performance.now() - started };
}

export const wavs = (folder: string) =>
  fs.existsSync(path.join(EVAL_DIR, folder))
    ? fs.readdirSync(path.join(EVAL_DIR, folder)).filter((f) => f.endsWith('.wav')).sort().map((f) => path.join(EVAL_DIR, folder, f))
    : [];

export const median = (values: number[]) => {
  const s = [...values].sort((a, b) => a - b);
  return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : 0;
};
