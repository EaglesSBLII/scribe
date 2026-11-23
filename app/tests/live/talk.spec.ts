import { expect, test, type Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

// A spoken conversation with the counselor: real Whisper, real Ollama, real Kokoro.
// The recording says "Jarvis, conversation mode.", then five questions about
// the essay with pauses for the answers, then a long request that is
// interrupted a few seconds in by "Wait, hold on a second."
//
// This test MEASURES the two speed targets and prints them:
//   - time from the end of a question to the first sound of the answer (target 2.5 s, median)
//   - time from talking over Scribe to its voice stopping (target 300 ms)

const essay = fs.readFileSync(path.resolve(import.meta.dirname, '../fixtures/essays/essay1.txt'), 'utf8').trim().split(/\n\s*\n/);

interface Metrics {
  turns: { speechEnd: number; transcribed?: number; firstToken?: number; firstSentence?: number; audioStart?: number }[];
  bargeIns: { onset: number; stopped: number }[];
}
const metrics = (page: Page) => page.evaluate(() => JSON.parse(JSON.stringify((window as unknown as { __scribeVoice: Metrics }).__scribeVoice)) as Metrics);
const median = (v: number[]) => {
  const s = [...v].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};

function stored(page: Page) {
  return page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve) => {
      const open = indexedDB.open('scribe');
      open.onsuccess = () => resolve(open.result);
    });
    const all = <T,>(store: string) => new Promise<T[]>((resolve) => {
      db.transaction(store).objectStore(store).getAll().onsuccess = (e) => resolve((e.target as IDBRequest).result);
    });
    const [essays, ops, chats] = [await all<{ doc: unknown }>('essays'), await all<unknown>('ops'), await all<{ role: string; text: string }>('chats')];
    db.close();
    return { doc: JSON.stringify(essays[0].doc), ops: ops.length, chats };
  });
}

test('a spoken conversation: fast to answer, stops when interrupted, never writes in the essay', async ({ page }) => {
  test.setTimeout(420_000);
  const outside: string[] = [];
  await page.route('**/*', (route) => {
    const url = route.request().url();
    if (url.startsWith('http://127.0.0.1:') || url.startsWith('data:') || url.startsWith('blob:')) return route.continue();
    outside.push(url);
    return route.abort();
  });
  await page.goto('/');
  await page.getByLabel('Your email').fill('writer@example.com');
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.getByRole('navigation').getByRole('button', { name: 'New essay' }).click();
  await page.getByRole('textbox', { name: 'Paragraph 1', exact: true }).click();
  for (const [i, para] of essay.entries()) {
    if (i > 0) await page.keyboard.press('Enter');
    await page.keyboard.insertText(para);
    await page.waitForTimeout(650);
  }
  await page.getByLabel('College').selectOption('commonapp');
  await page.getByLabel('Prompt').selectOption('commonapp-2');
  await page.waitForTimeout(500);
  const before = await stored(page);

  // The microphone opens here, and the recording starts.
  await page.getByRole('button', { name: 'Start dictation' }).click();
  await expect(page.getByTestId('command-chip')).toContainText('Conversation mode', { timeout: 60_000 });

  const replies = page.getByTestId('chat').locator('[data-role="assistant"]');
  // Five answered questions, the long one that is talked over, and the answer to "wait, hold on".
  await expect(replies).toHaveCount(7, { timeout: 240_000 });
  // A reply cut off while it was still being written is marked; one already written in full is not.
  expect(await replies.filter({ hasText: '[interrupted]' }).count()).toBeLessThanOrEqual(1);
  await page.waitForTimeout(12_000);

  const m = await metrics(page);
  const answered = m.turns.filter((t) => t.audioStart !== undefined && t.firstToken !== undefined);
  const toSpeech = answered.map((t) => t.audioStart! - t.speechEnd);
  const part = (a: keyof Metrics['turns'][number], b: keyof Metrics['turns'][number]) => Math.round(median(answered.map((t) => (t[b] as number) - (t[a] as number))));
  console.log(`\nTIME TO FIRST SPEECH (question end -> first sound), ${answered.length} turns: ${toSpeech.map((x) => (x / 1000).toFixed(2)).join(', ')} s`);
  console.log(`  median ${(median(toSpeech) / 1000).toFixed(2)} s, best ${(Math.min(...toSpeech) / 1000).toFixed(2)} s, worst ${(Math.max(...toSpeech) / 1000).toFixed(2)} s   (target 2.5 s)`);
  console.log(`  median by stage: heard ${part('speechEnd', 'transcribed')} ms, model's first word ${part('transcribed', 'firstToken')} ms, first sentence written ${part('firstToken', 'firstSentence')} ms, voice ${part('firstSentence', 'audioStart')} ms`);
  const stops = m.bargeIns.map((b) => b.stopped - b.onset);
  console.log(`BARGE-IN (talking over it -> voice stopped): ${stops.map((x) => Math.round(x)).join(', ')} ms   (target 300 ms)`);

  const after = await stored(page);
  const said = after.chats.filter((c) => c.role === 'user').map((c) => c.text);
  const answers = after.chats.filter((c) => c.role === 'assistant').map((c) => c.text);
  console.log('WHAT THE STUDENT SAID:\n  ' + said.join('\n  '));
  console.log('WHAT THE COUNSELOR SAID:\n  ' + answers.map((a) => a.replace(/\s+/g, ' ')).join('\n  '));

  // It spoke, and every time it was talked over it stopped.
  expect(answered.length).toBeGreaterThanOrEqual(5);
  expect(m.bargeIns.length).toBeGreaterThanOrEqual(1);
  expect(Math.max(...stops)).toBeLessThanOrEqual(300);
  // The essay is byte-for-byte what it was: same document, same edit log.
  expect(after.doc).toBe(before.doc);
  expect(after.ops).toBe(before.ops);
  // The counselor's own words were never taken down as the student's.
  for (const answer of answers) {
    const opening = answer.split(/\s+/).slice(0, 6).join(' ').toLowerCase();
    for (const s of said) expect(s.toLowerCase()).not.toContain(opening);
  }
  expect(said).toHaveLength(7);
  expect(outside).toEqual([]);
  // Reported, with the target asserted last so the numbers above are always printed.
  expect(median(toSpeech)).toBeLessThanOrEqual(2500);
});
