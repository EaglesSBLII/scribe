// Builds tests/fixtures/ideas.wav: a student telling the counselor a whole idea
// the way people talk, with pauses for breath in the middle of it, then adding
// an afterthought. Used by tests/live/ideas.spec.ts.
import { execFileSync } from 'node:child_process';
import path from 'node:path';

const text = [
  '[[slnc 9000]] Jarvis, conversation mode. [[slnc 6000]]',
  "So I want to write about the summer my grandfather's boat broke down. [[slnc 1200]]",
  'We were out on the lake and the engine just would not start, and [[slnc 1500]]',
  'I kept pulling the cord because I was sure I had followed the notebook exactly. [[slnc 1300]]',
  'But he just laughed and said the mistake was in the notebook, not in my hands. [[slnc 28000]]',
  'Wait, also, um, [[slnc 2000]]',
  'I think that is when I stopped trusting instructions over what I could see. [[slnc 30000]]',
].join(' ');
const out = path.resolve(import.meta.dirname, '../tests/fixtures/ideas.wav');
execFileSync('say', ['-o', out, '--data-format=LEI16@16000', text]);
console.log(`Wrote ${out}`);
