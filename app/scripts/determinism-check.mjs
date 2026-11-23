// Measures whether the local model gives the same answer to the same grading
// request. Run with: node scripts/determinism-check.mjs [model]
// It sends one fixed request several times under different conditions and
// prints the levels it got back.
import fs from 'node:fs';
import path from 'node:path';

const MODEL = process.argv[2] ?? 'qwen3.5:9b';
const essay = fs.readFileSync(path.resolve(import.meta.dirname, '../tests/fixtures/essays/essay1.txt'), 'utf8').trim();

const messages = [
  { role: 'system', content: 'You grade a college application essay against one rubric section. Answer in JSON with "level" (1-10), "quote" (one exact line from the essay) and "reason" (one sentence).' },
  { role: 'user', content: `PROMPT\nThe lessons we take from obstacles we encounter can be fundamental to later success. Recount a time when you faced a challenge, setback, or failure. How did it affect you, and what did you learn from the experience?\n\nESSAY\n${essay}` },
  { role: 'user', content: 'SECTION TO GRADE\nprompt — Answers the prompt: Does the essay answer every part of the question that was asked?\n  levels 1-2: Does not address the prompt.\n  levels 3-4: Touches the topic but leaves most parts unanswered.\n  levels 5-6: Answers the main part; one part is missing or only implied.\n  levels 7-8: Answers every part clearly; one part is thinner.\n  levels 9-10: Answers every part fully and directly.' },
];
const format = { type: 'object', required: ['level', 'quote', 'reason'], properties: { level: { type: 'integer' }, quote: { type: 'string' }, reason: { type: 'string' } } };

async function call(options = {}, extra = {}) {
  const res = await fetch('http://127.0.0.1:11434/api/chat', {
    method: 'POST',
    body: JSON.stringify({ model: MODEL, messages, format, stream: false, think: false, options: { temperature: 0, seed: 7, top_k: 1, num_ctx: 8192, ...options }, ...extra }),
  });
  const data = await res.json();
  if (data.error) throw new Error(data.error);
  const parsed = JSON.parse(data.message.content);
  return { level: parsed.level, text: data.message.content, cached: data.prompt_eval_cached_count ?? '?', evaluated: data.prompt_eval_count };
}

async function distract() {
  // An unrelated request, so the next call cannot reuse this conversation's cached state.
  await fetch('http://127.0.0.1:11434/api/chat', {
    method: 'POST',
    body: JSON.stringify({ model: MODEL, stream: false, think: false, options: { temperature: 0, num_predict: 8 }, messages: [{ role: 'user', content: `Say the number ${Math.floor(Math.random() * 1e6)}.` }] }),
  });
}

async function trial(name, n, before, options, extra) {
  const got = [];
  for (let i = 0; i < n; i++) {
    if (before) await before();
    got.push(await call(options, extra));
  }
  const texts = new Set(got.map((g) => g.text));
  console.log(`${name.padEnd(44)} levels ${got.map((g) => g.level).join(' ')}   distinct full answers: ${texts.size}   cached tokens: ${got.map((g) => g.cached).join(' ')}`);
  return got;
}

console.log(`model ${MODEL}`);
await trial('A. same request back to back', 6);
await trial('B. unrelated request before each', 6, distract);
await trial('C. model unloaded before each (cold start)', 3, async () => {
  await fetch('http://127.0.0.1:11434/api/generate', { method: 'POST', body: JSON.stringify({ model: MODEL, keep_alive: 0 }) });
  await new Promise((r) => setTimeout(r, 1500));
});
await trial('D. CPU only (num_gpu 0), back to back', 3, null, { num_gpu: 0 });
