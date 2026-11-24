// Builds recordings of spoken requests with the Mac's built-in voices.
// Run with: node app/scripts/wake-eval/make-commands-audio.mjs
// Output goes to .tools/wake-eval/commands/ (not kept in git).
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { ADDRESSED, ESSAY, PLAIN, VOICES } from './commands.mjs';

const out = path.resolve(import.meta.dirname, '../../../.tools/wake-eval/commands');
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });

function say(voice, text, file) {
  execFileSync('say', ['-v', voice, '-r', '185', '-o', file, '--data-format=LEI16@16000', `[[slnc 600]] ${text} [[slnc 1300]]`]);
}

let n = 0;
for (const voice of VOICES) {
  ADDRESSED.forEach(([text], i) => { say(voice, `Jarvis, ${text}.`, path.join(out, `addressed-${String(i).padStart(2, '0')}-${voice}.wav`)); n++; });
  PLAIN.forEach(([text], i) => { say(voice, text, path.join(out, `plain-${String(i).padStart(2, '0')}-${voice}.wav`)); n++; });
  ESSAY.forEach((text, i) => { say(voice, text, path.join(out, `essay-${String(i).padStart(2, '0')}-${voice}.wav`)); n++; });
}
console.log(`commands: ${n} clips in ${out}`);
