import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { Chunker, encodeWav } from '../../src/dictation/chunker';
import { clean, type HeardWord } from '../../src/dictation/clean';
import { looksLikeNoise, makeHighPass, type Quality } from '../../src/dictation/frontend';
import { EVAL_DIR, readWav, whisper } from './audio';
import { cases as walkCases, DIR, LEAD, mix, RATE } from './walk';

// Dictating on a walk: the same two essays, read aloud, with wind, street noise
// or other people talking mixed in, and a stretch of background alone before
// and after. Measured both the original way ("before") and with the outdoor
// handling ("after"): how many of the writer's words came out wrong, and how
// many words were written when the writer was not speaking at all.
// Voices: node app/scripts/wake-eval/make-noise-audio.mjs
// The browser's own noise suppression and AirPods are NOT part of this.

type Heard = { text: string; words: (HeardWord & { p?: number })[]; quality?: Quality };
const transcribe = whisper.transcribe as unknown as (wav: Buffer) => Promise<Heard>;
const report: string[] = [];
const log = (line: string) => { report.push(line); console.log(line); };

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9' ]/g, ' ').split(/\s+/).filter(Boolean);

/** Words wrong (changed, missing or extra) as a share of the words actually said. */
function wordErrors(said: string[], got: string[]): number {
  let row = Array.from({ length: got.length + 1 }, (_, j) => j);
  for (let i = 1; i <= said.length; i++) {
    const next = [i];
    for (let j = 1; j <= got.length; j++) next[j] = Math.min(row[j] + 1, next[j - 1] + 1, row[j - 1] + (said[i - 1] === got[j - 1] ? 0 : 1));
    row = next;
  }
  return row[got.length] / said.length;
}

async function run(audio: Float32Array, after: boolean) {
  const chunks: { start: number; end: number; samples: Float32Array }[] = [];
  let fed = 0;
  const chunker = new Chunker({ endSilence: 0.9, classic: !after, onChunk: (s) => chunks.push({ start: fed - s.length, end: fed, samples: s }) });
  const filter = after ? makeHighPass() : (x: Float32Array) => x;
  for (let i = 0; i < audio.length; i += 2048) {
    const block = filter(audio.subarray(i, Math.min(audio.length, i + 2048)));
    fed = Math.min(audio.length, i + 2048);
    chunker.feed(block);
  }
  chunker.flush();
  const speechEnd = audio.length - LEAD;
  const text: string[] = [];
  let phantom = 0;
  let dropped = 0;
  for (const c of chunks) {
    if (c.samples.length < 0.35 * RATE) continue;
    const heard = await transcribe(Buffer.from(encodeWav(c.samples)));
    const outside = c.end < LEAD + RATE || c.start > speechEnd;
    if (after && looksLikeNoise(heard, c.samples)) {
      dropped++;
      continue;
    }
    const words = norm(clean(heard.words, { final: true }).text);
    if (outside && words.length && after && process.env.SCRIBE_DEBUG) {
      const ps = heard.words.map((w) => w.p ?? 1);
      console.log(`    phantom: "${heard.text.trim()}" noSpeech ${heard.quality?.noSpeech.toFixed(2)} logprob ${heard.quality?.logprob.toFixed(2)} mean p ${(ps.reduce((x, y) => x + y, 0) / ps.length).toFixed(2)} ${(c.samples.length / RATE).toFixed(1)}s`);
    }
    if (outside) phantom += words.length;
    else text.push(...words);
  }
  return { text, phantom, chunks: chunks.length, dropped, longest: Math.max(0, ...chunks.map((c) => c.samples.length / RATE)) };
}

beforeAll(async () => { await whisper.start(); });
afterAll(() => {
  whisper.stop();
  fs.writeFileSync(path.join(EVAL_DIR, 'noise-results.txt'), report.join('\n') + '\n');
});

it('dictation with outdoor noise: words wrong, and words written when nobody was dictating', async () => {
  const speech = readWav(path.join(DIR, 'speech.wav'));
  const said = norm(clean(fs.readFileSync(path.join(DIR, 'speech.txt'), 'utf8'), { final: true }).text);
  const n = speech.length + 2 * LEAD;
  const cases = walkCases(n);
  log(`WALK TEST: ${said.length} words said, ${(speech.length / RATE / 60).toFixed(1)} minutes, 30 s of background alone per case`);
  log('  case                                 | words wrong before -> after | written in silence before -> after | longest stretch before -> after');
  const worse: string[] = [];
  for (const [name, noise, snr] of cases) {
    const audio = mix(speech, noise, snr);
    const b = await run(audio, false);
    const a = await run(audio, true);
    const wb = wordErrors(said, b.text);
    const wa = wordErrors(said, a.text);
    log(`  ${name.padEnd(36)} | ${(wb * 100).toFixed(1).padStart(5)}% -> ${(wa * 100).toFixed(1).padStart(5)}%            | ${String(b.phantom).padStart(3)} -> ${String(a.phantom).padStart(3)} words                  | ${b.longest.toFixed(0)} s -> ${a.longest.toFixed(0)} s   (${a.dropped} dropped as noise)`);
    if (wa > wb + 0.02) worse.push(name);
  }
  expect(worse).toEqual([]);
});
