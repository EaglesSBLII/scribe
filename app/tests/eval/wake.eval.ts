import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { readWake } from '../../src/voice/wake';
import { EVAL_DIR, hear, median, readWav, utterances, wavs, whisper } from './audio';

// Wake word measured the way Scribe uses it: the microphone path splits speech
// into utterances, local Whisper transcribes each, and readWake decides.
// Recordings come from scripts/wake-eval/make-audio.mjs.

const STANDBY = { endSilence: 0.5 };
const report: string[] = [];
const log = (line: string) => { report.push(line); console.log(line); };

beforeAll(async () => { await whisper.start(); });
afterAll(() => {
  whisper.stop();
  fs.writeFileSync(path.join(EVAL_DIR, 'whisper-gate-results.txt'), report.join('\n') + '\n');
});

it('wakes on "Jarvis", "Hey Jarvis" and "Jarvis, <request>"', async () => {
  const files = wavs('positive');
  expect(files.length).toBeGreaterThan(0);
  const missed: string[] = [];
  const times: number[] = [];
  const byKind: Record<string, [number, number]> = {};
  for (const file of files) {
    const kind = path.basename(file).split('-')[0];
    byKind[kind] ??= [0, 0];
    byKind[kind][1]++;
    let woke = false;
    const heardAs: string[] = [];
    for (const u of utterances(readWav(file), STANDBY)) {
      const h = await hear(u.samples);
      heardAs.push(h.text.replace(/\s+/g, ' '));
      times.push(h.ms);
      if (readWake(h.words).wake) woke = true;
    }
    if (woke) byKind[kind][0]++;
    else missed.push(`${path.basename(file)} heard as: ${JSON.stringify(heardAs)}`);
  }
  log(`WHISPER GATE, calls: ${files.length - missed.length}/${files.length} woke (missed ${missed.length})`);
  for (const [kind, [hit, total]] of Object.entries(byKind)) log(`  ${kind}: ${hit}/${total}`);
  for (const m of missed) log(`  MISSED ${m}`);
  log(`  Whisper time per utterance: median ${Math.round(median(times))} ms, worst ${Math.round(Math.max(...times))} ms`);
  expect(missed.length / files.length).toBeLessThanOrEqual(0.1);
});

it('does not wake when the name is part of the dictated sentence', async () => {
  const files = wavs('content');
  const wrong: string[] = [];
  for (const file of files) {
    for (const u of utterances(readWav(file), STANDBY)) {
      const h = await hear(u.samples);
      if (readWake(h.words).wake) wrong.push(`${path.basename(file)}: ${h.text.trim()}`);
    }
  }
  log(`WHISPER GATE, name inside a sentence: ${wrong.length} false wakes in ${files.length} clips`);
  for (const w of wrong) log(`  FALSE WAKE ${w}`);
  expect(wrong).toEqual([]);
});

it('false wakes during ordinary dictation: at most 1 in 10 minutes', async () => {
  const files = wavs('negative');
  let seconds = 0;
  let count = 0;
  const wrong: string[] = [];
  for (const file of files) {
    const samples = readWav(file);
    seconds += samples.length / 16000;
    for (const u of utterances(samples, STANDBY)) {
      count++;
      const h = await hear(u.samples);
      if (readWake(h.words).wake) wrong.push(`${path.basename(file)} at ${u.endsAt.toFixed(0)} s: ${h.text.trim()}`);
    }
  }
  const per10 = (wrong.length / seconds) * 600;
  log(`WHISPER GATE, dictation: ${wrong.length} false wakes in ${(seconds / 60).toFixed(1)} minutes (${count} utterances) = ${per10.toFixed(2)} per 10 minutes`);
  for (const w of wrong) log(`  FALSE WAKE ${w}`);
  expect(per10).toBeLessThanOrEqual(1);
});
