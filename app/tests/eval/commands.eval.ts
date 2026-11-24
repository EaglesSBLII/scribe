import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { mayChangeEssay, parseCommand, type Command } from '../../src/commands/parse';
import { encodeWav } from '../../src/dictation/chunker';
import type { HeardWord } from '../../src/dictation/clean';
import { readWake } from '../../src/voice/wake';
// @ts-expect-error plain JavaScript data shared with the script that makes the recordings
import { ADDRESSED, ESSAY, PLAIN } from '../../scripts/wake-eval/commands.mjs';
import { EVAL_DIR, readWav, utterances, wavs, whisper } from './audio';

// How well Scribe understands spoken requests, measured end to end on the fixed
// rules alone: recording -> the microphone's utterance splitter -> local Whisper
// (quick first, exact when the request could change the essay, as the app does)
// -> wake word -> command grammar. The local model, which the app asks when the
// rules do not match, is NOT used here, so the app itself does a little better.
// Recordings: node app/scripts/wake-eval/make-commands-audio.mjs

type Heard = { text: string; words: HeardWord[] };
const transcribe = whisper.transcribe as unknown as (wav: Buffer, opts?: { quick?: boolean }) => Promise<Heard>;
const report: string[] = [];
const log = (line: string) => { report.push(line); console.log(line); };

/** Every listed field of `want` is in `got`. */
function matches(got: unknown, want: unknown): boolean {
  if (typeof want === 'string') return typeof got === 'string' && got.toLowerCase() === want.toLowerCase();
  if (want === null || typeof want !== 'object') return got === want;
  if (got === null || typeof got !== 'object') return false;
  return Object.entries(want as object).every(([k, v]) => matches((got as Record<string, unknown>)[k], v));
}

/** One clip, heard the way the app hears something said while dictating. */
async function understand(file: string): Promise<{ heard: string; addressed: boolean; command: Command | null }> {
  const parts = utterances(readWav(file), { endSilence: 0.9 });
  const samples = parts.length === 1 ? parts[0].samples : readWav(file);
  const wav = Buffer.from(encodeWav(samples));
  let heard = await transcribe(wav, { quick: true });
  let wake = readWake(heard.words);
  // Essay text and anything that could change the essay is heard again, exactly.
  if (!wake.wake || mayChangeEssay(wake.rest)) {
    heard = await transcribe(wav);
    wake = readWake(heard.words);
  }
  const command = wake.wake ? (wake.alone ? null : parseCommand(wake.rest, { addressed: true })) : parseCommand(heard.words);
  return { heard: heard.text.replace(/\s+/g, ' ').trim(), addressed: wake.wake, command };
}

beforeAll(async () => { await whisper.start(); });
afterAll(() => {
  whisper.stop();
  fs.writeFileSync(path.join(EVAL_DIR, 'commands-results.txt'), report.join('\n') + '\n');
});

async function run(kind: 'addressed' | 'plain', list: [string, object][]) {
  const files = wavs('commands').filter((f) => path.basename(f).startsWith(kind));
  expect(files.length).toBeGreaterThan(0);
  const wrong: string[] = [];
  const byPhrase = new Map<string, number>();
  for (const file of files) {
    const index = Number(path.basename(file).split('-')[1]);
    const [said, want] = list[index];
    const got = await understand(file);
    const ok = (kind === 'plain' || got.addressed) && matches(got.command, want);
    if (!ok) {
      byPhrase.set(said, (byPhrase.get(said) ?? 0) + 1);
      wrong.push(`"${said}" (${path.basename(file, '.wav').split('-')[2]}) heard as "${got.heard}" -> ${got.addressed || kind === 'plain' ? JSON.stringify(got.command) : 'name not heard'}`);
    }
  }
  const right = files.length - wrong.length;
  log(`${kind === 'addressed' ? 'SAID TO JARVIS' : 'PLAIN COMMANDS WHILE DICTATING'}: ${right}/${files.length} understood (${((100 * right) / files.length).toFixed(1)}%), ${list.length} phrasings`);
  for (const w of wrong) log(`  MISSED ${w}`);
  return { right, total: files.length, byPhrase };
}

it('requests said to Jarvis become the right command', async () => {
  const { right, total } = await run('addressed', ADDRESSED as [string, object][]);
  expect(right / total).toBeGreaterThanOrEqual(0.9);
});

it('plain commands said while dictating still work', async () => {
  const { right, total } = await run('plain', PLAIN as [string, object][]);
  expect(right / total).toBeGreaterThanOrEqual(0.9);
});

it('ordinary sentences that use the same words stay essay text', async () => {
  const files = wavs('commands').filter((f) => path.basename(f).startsWith('essay'));
  const wrong: string[] = [];
  for (const file of files) {
    const got = await understand(file);
    if (got.addressed || got.command) wrong.push(`"${(ESSAY as string[])[Number(path.basename(file).split('-')[1])]}" heard as "${got.heard}" -> ${JSON.stringify(got.command)}`);
  }
  log(`ESSAY SENTENCES: ${files.length - wrong.length}/${files.length} left alone`);
  for (const w of wrong) log(`  TAKEN AS A COMMAND ${w}`);
  expect(wrong).toEqual([]);
});
