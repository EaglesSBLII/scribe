// Builds the wake-word test recordings with the Mac's built-in voices.
// Run with: node app/scripts/wake-eval/make-audio.mjs
// Output goes to .tools/wake-eval/ (not kept in git; it is easy to rebuild).
//
//   positive/  one clip per voice, phrase and speed that SHOULD wake Scribe
//   content/   sentences that contain the name but are essay text, not a call
//   negative/  about ten minutes of ordinary dictation, including near-words
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '../../..');
const out = path.join(root, '.tools', 'wake-eval');
const VOICES = ['Samantha', 'Daniel', 'Karen', 'Moira', 'Rishi', 'Aman', 'Tara', 'Tessa', 'Kathy', 'Ralph'];
const RATES = [165, 205];

function say(voice, rate, text, file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  execFileSync('say', ['-v', voice, '-r', String(rate), '-o', file, '--data-format=LEI16@16000', text]);
}

// 1. Calls that should wake it.
const CALLS = [
  ['alone', 'Jarvis.'],
  ['hey', 'Hey Jarvis.'],
  ['request', 'Jarvis, how many words do I have?'],
];
let n = 0;
for (const voice of VOICES) {
  for (const rate of RATES) {
    for (const [kind, text] of CALLS) {
      say(voice, rate, `[[slnc 700]] ${text} [[slnc 1500]]`, path.join(out, 'positive', `${kind}-${voice}-${rate}.wav`));
      n++;
    }
  }
}
console.log(`positive: ${n} clips`);

// 2. The name as part of what is being dictated.
const CONTENT = [
  'My friend called me Jarvis.',
  'Everyone at camp called me Jarvis because of the movie.',
  'Jarvis was my nickname in middle school.',
  'We named the robot Jarvis and it never worked.',
  'Jarvis is what my little brother calls our dog.',
  'The first person I told was Jarvis.',
];
n = 0;
for (const [i, voice] of ['Samantha', 'Daniel', 'Rishi', 'Karen'].entries()) {
  for (const [j, text] of CONTENT.entries()) {
    say(voice, 180, `[[slnc 700]] ${text} [[slnc 1500]]`, path.join(out, 'content', `content-${j + 1}-${voice}.wav`));
    n++;
  }
  void i;
}
console.log(`content: ${n} clips`);

// 3. Ordinary dictation: the five test essays plus sentences full of near-words.
const essays = [1, 2, 3, 4, 5].map((k) => fs.readFileSync(path.join(root, 'app/tests/fixtures/essays', `essay${k}.txt`), 'utf8'));
const NEAR = [
  'Travis drove us to the service station after practice.',
  'It was a jarring sound, like a jar of marbles on the stairs.',
  'The harvest festival was the largest in Jarrow that year.',
  'Our service project was at the nervous system clinic.',
  'Charles and Mavis were carving pumpkins in the garage.',
  'I asked Travis whether the scarves were his.',
  'He said the jargon in the manual was useless.',
  'Hey, just give us a minute, I said.',
  'The jury was still out on Marvin and his starving artist plan.',
  'A java service crashed, and Davis fixed it.',
];
const sentences = (essays.join(' ') + ' ' + NEAR.join(' ') + ' ' + NEAR.join(' '))
  .replace(/\s+/g, ' ')
  .match(/[^.!?]+[.!?]+["”]?/g)
  .map((s) => s.trim())
  .filter(Boolean);
let seconds = 0;
const third = Math.ceil(sentences.length / 3);
for (const [i, voice] of ['Samantha', 'Daniel', 'Rishi'].entries()) {
  const part = sentences.slice(i * third, (i + 1) * third);
  // Twice through at two speeds, with a dictation-like pause after each sentence.
  for (const rate of [160, 190]) {
    const file = path.join(out, 'negative', `dictation-${voice}-${rate}.wav`);
    say(voice, rate, part.map((s) => `${s} [[slnc 1300]]`).join(' '), file);
    seconds += (fs.statSync(file).size - 4096) / 32000;
  }
}
console.log(`negative: 6 files, ${(seconds / 60).toFixed(1)} minutes, ${sentences.length} distinct sentences`);
