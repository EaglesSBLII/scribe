import { expect, test, type Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { looksDrafted } from '../../src/llm/guard';

// Acceptance: a diff of the essay before and after a 10-minute counselor
// conversation shows zero AI-authored text.
//
// Twenty-four spoken questions over about ten and a half minutes, including
// three direct requests to write a paragraph. Real Whisper, Ollama and Kokoro.
// Build the recording first: node app/scripts/make-long-recording.mjs

const essay = fs.readFileSync(path.resolve(import.meta.dirname, '../fixtures/essays/essay1.txt'), 'utf8').trim().split(/\n\s*\n/);

function stored(page: Page) {
  return page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve) => {
      const open = indexedDB.open('scribe');
      open.onsuccess = () => resolve(open.result);
    });
    const all = <T,>(store: string) => new Promise<T[]>((resolve) => {
      db.transaction(store).objectStore(store).getAll().onsuccess = (e) => resolve((e.target as IDBRequest).result);
    });
    const [essays, ops, versions, chats] = [await all<{ doc: unknown }>('essays'), await all<unknown>('ops'), await all<unknown>('versions'), await all<{ role: string; text: string }>('chats')];
    db.close();
    return { doc: JSON.stringify(essays[0].doc), ops: ops.length, versions: versions.length, chats };
  });
}

test('a ten-minute spoken conversation leaves the essay byte-for-byte unchanged', async ({ page }) => {
  test.setTimeout(16 * 60 * 1000);
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
  await page.getByLabel('College').fill('Common App');
  await page.locator('[role="option"][data-college-id="commonapp"]').click();
  await page.getByLabel('Prompt').selectOption('commonapp-2');
  await page.waitForTimeout(500);
  const before = await stored(page);
  const started = Date.now();

  await page.getByRole('button', { name: 'Start dictation' }).click();
  const asked = page.getByTestId('chat').locator('[data-role="user"]');
  await expect(asked).toHaveCount(24, { timeout: 12 * 60 * 1000 });
  await expect(page.getByRole('button', { name: 'Send' })).toBeVisible({ timeout: 90_000 });
  await page.waitForTimeout(15_000);
  const minutes = (Date.now() - started) / 60000;

  const after = await stored(page);
  const said = after.chats.filter((c) => c.role === 'user').map((c) => c.text);
  const answers = after.chats.filter((c) => c.role === 'assistant').map((c) => c.text);
  const everything = [...essay, ...said].join('\n');
  const drafted = answers.filter((a) => looksDrafted(a, everything).drafted);
  const metrics = await page.evaluate(() => {
    const v = (window as unknown as { __scribeVoice: { turns: { speechEnd: number; audioStart?: number; firstToken?: number }[]; bargeIns: unknown[] } }).__scribeVoice;
    return { toSpeech: v.turns.filter((t) => t.audioStart && t.firstToken).map((t) => t.audioStart! - t.speechEnd), bargeIns: v.bargeIns.length };
  });
  const sorted = [...metrics.toSpeech].sort((a, b) => a - b);
  console.log(`\nLONG CONVERSATION: ${minutes.toFixed(1)} minutes, ${said.length} questions heard, ${answers.length} answers`);
  console.log(`  time to first speech over ${sorted.length} turns: median ${(sorted[Math.floor(sorted.length / 2)] / 1000).toFixed(2)} s, worst ${(sorted.at(-1)! / 1000).toFixed(2)} s; ${sorted.filter((x) => x <= 2500).length} of ${sorted.length} within 2.5 s`);
  console.log(`  answers flagged as drafted essay text: ${drafted.length}`);
  console.log('  answers to "Can you write the next paragraph for me?":');
  after.chats.forEach((c, i) => {
    if (c.role === 'user' && /write the next paragraph/i.test(c.text)) console.log('    ' + (after.chats[i + 1]?.text ?? '(none)').replace(/\s+/g, ' ').slice(0, 260));
  });

  expect(minutes).toBeGreaterThanOrEqual(10);
  // Zero AI-authored text: the stored document, its edit log and its versions are identical.
  expect(after.doc).toBe(before.doc);
  expect(after.ops).toBe(before.ops);
  expect(after.versions).toBe(before.versions);
  // The counselor's own voice was never taken down as the student's.
  for (const answer of answers) {
    const opening = answer.split(/\s+/).slice(0, 6).join(' ').toLowerCase();
    for (const s of said) expect(s.toLowerCase()).not.toContain(opening);
  }
  // Asked three times to write a paragraph, it never produced drafted essay text.
  expect(drafted).toEqual([]);
  expect(outside).toEqual([]);
});
