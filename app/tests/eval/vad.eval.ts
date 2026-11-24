import path from 'node:path';
import { expect, it } from 'vitest';
import { Chunker } from '../../src/dictation/chunker';
import { makeHighPass, voicedShare } from '../../src/dictation/frontend';
import { readWav } from './audio';
import { cases, DIR, LEAD, mix, RATE } from './walk';

// Quick check of the speech detector alone (no Whisper): how much of the
// writer's speech ends up inside a stretch that is sent on, how much
// background-only time is sent, and how long the longest stretch is.

function spans(audio: Float32Array, classic: boolean) {
  const out: [number, number][] = [];
  let fed = 0;
  const chunker = new Chunker({ endSilence: 0.9, classic, onChunk: (s) => out.push([fed - s.length, fed]) });
  const filter = classic ? (x: Float32Array) => x : makeHighPass();
  for (let i = 0; i < audio.length; i += 2048) {
    fed = Math.min(audio.length, i + 2048);
    chunker.feed(filter(audio.subarray(i, fed)));
  }
  chunker.flush();
  return out;
}

it('speech detector under outdoor noise', () => {
  const speech = readWav(path.join(DIR, 'speech.wav'));
  const n = speech.length + 2 * LEAD;
  // Where the writer is really speaking: what the detector finds with no background at all.
  const truth = new Uint8Array(n);
  for (const [a, b] of spans(mix(speech, null, 0), true)) truth.fill(1, Math.max(0, a), b);
  const speaking = truth.reduce((x, y) => x + y, 0);
  console.log('  case                                 | speech kept | background sent (of 30 s) | stretches | longest');
  for (const [name, noise, snr] of cases(n)) {
    for (const classic of [true, false]) {
      const got = spans(mix(speech, noise, snr), classic);
      const sent = new Uint8Array(n);
      for (const [a, b] of got) sent.fill(1, Math.max(0, a), b);
      let kept = 0;
      let extra = 0;
      for (let i = 0; i < n; i++) {
        if (truth[i] && sent[i]) kept++;
        if (sent[i] && (i < LEAD - RATE || i > n - LEAD + RATE)) extra++;
      }
      if (!classic) {
        const audio = mix(speech, noise, snr);
        const hp = makeHighPass()(audio);
        const share = (a: number, b: number) => voicedShare(hp.subarray(Math.max(0, a), b));
        const out = got.filter(([a, b]) => b < LEAD || a > n - LEAD).map(([a, b]) => share(a, b));
        const inn = got.filter(([a, b]) => !(b < LEAD || a > n - LEAD)).map(([a, b]) => share(a, b));
        console.log(`      voice share: background-only [${out.map((x) => x.toFixed(2)).join(' ')}]  with speech: lowest ${Math.min(...inn).toFixed(2)}, median ${[...inn].sort()[Math.floor(inn.length / 2)]?.toFixed(2)}`);
      }
      console.log(`  ${(classic ? name : '   after').padEnd(36)} | ${((100 * kept) / speaking).toFixed(0).padStart(4)}%       | ${(extra / RATE).toFixed(1).padStart(5)} s                   | ${String(got.length).padStart(4)}      | ${Math.max(0, ...got.map(([a, b]) => (b - a) / RATE)).toFixed(0)} s`);
    }
  }
  expect(true).toBe(true);
});
