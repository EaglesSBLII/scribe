// Builds tests/fixtures/long.wav: about ten minutes of a student asking the
// counselor questions, for the long live test (npm run e2e:long -w app).
// The file is about 20 MB, so it is generated rather than kept in git.
import { execFileSync } from 'node:child_process';
import path from 'node:path';

const QUESTIONS = [
  'What do you think of my opening?',
  'Is the ending clear?',
  'What should I add about my grandfather?',
  'Does this answer the prompt?',
  'Should I cut the line about the notebook?',
  'Can you write the next paragraph for me?',
  'Which line sounds most like me?',
  'What is missing from this essay?',
];
const GAP = '[[slnc 24000]]';
const text = `[[slnc 9000]] Jarvis, conversation mode. [[slnc 6000]] ${[1, 2, 3].map(() => QUESTIONS.map((q) => `${q} ${GAP}`).join(' ')).join(' ')}`;
const out = path.resolve(import.meta.dirname, '../tests/fixtures/long.wav');
execFileSync('say', ['-o', out, '--data-format=LEI16@16000', text]);
console.log(`Wrote ${out}`);
