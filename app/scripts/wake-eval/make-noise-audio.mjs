// Speech and background voices for the "dictating on a walk" measurement.
// Run with: node app/scripts/wake-eval/make-noise-audio.mjs
// Output goes to .tools/wake-eval/noise/ (not kept in git). Wind and street
// noise are made by the test itself; only the voices need the Mac's `say`.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '../../..');
const out = path.join(root, '.tools', 'wake-eval', 'noise');
fs.mkdirSync(out, { recursive: true });
const essay = (k) => fs.readFileSync(path.join(root, 'app/tests/fixtures/essays', `essay${k}.txt`), 'utf8').replace(/\s+/g, ' ').trim();
const say = (voice, rate, text, file) => execFileSync('say', ['-v', voice, '-r', String(rate), '-o', path.join(out, file), '--data-format=LEI16@16000', text]);

// The writer: two essays, with a natural pause after each sentence.
const spoken = `${essay(1)} ${essay(2)}`;
fs.writeFileSync(path.join(out, 'speech.txt'), spoken);
say('Samantha', 180, spoken.replace(/([.?!])\s+/g, '$1 [[slnc 700]] '), 'speech.wav');
// Other people talking nearby.
say('Daniel', 175, essay(3), 'other-1.wav');
say('Karen', 190, essay(4), 'other-2.wav');
say('Rishi', 170, essay(5), 'other-3.wav');
console.log(`noise: speech and three other voices in ${out}`);
