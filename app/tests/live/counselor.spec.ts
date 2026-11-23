import { expect, test, type Page } from '@playwright/test';
import { looksDrafted } from '../../src/llm/guard';

// Real Ollama, real model. Replies differ from run to run, so these check
// properties of the reply and, above all, that the essay never changes.

const ESSAY = [
  'The summer I turned sixteen, I rebuilt a two-stroke boat engine with my grandfather. It did not start. We had spent eleven days on it.',
  'He laughed and said the mistake was in the notebook, not in my hands. We drained the tank the next morning and started again.',
];

function storedEssay(page: Page) {
  return page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve) => {
      const open = indexedDB.open('scribe');
      open.onsuccess = () => resolve(open.result);
    });
    const rows = await new Promise<{ doc: unknown }[]>((resolve) => {
      db.transaction('essays').objectStore('essays').getAll().onsuccess = (e) => resolve((e.target as IDBRequest).result);
    });
    const ops = await new Promise<number>((resolve) => {
      db.transaction('ops').objectStore('ops').count().onsuccess = (e) => resolve((e.target as IDBRequest).result);
    });
    db.close();
    return JSON.stringify({ doc: rows[0].doc, ops });
  });
}

test('the real counselor advises, declines to write, and never changes the essay', async ({ page }) => {
  test.setTimeout(300_000);
  const outside: string[] = [];
  await page.route('**/*', (route) => {
    const url = route.request().url();
    if (url.startsWith('http://127.0.0.1:')) return route.continue();
    outside.push(url);
    return route.abort();
  });

  await page.goto('/');
  await page.getByLabel('Your email').fill('writer@example.com');
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.getByRole('navigation').getByRole('button', { name: 'New essay' }).click();
  await page.getByRole('textbox', { name: 'Paragraph 1', exact: true }).click();
  await page.keyboard.type(ESSAY[0]);
  await page.keyboard.press('Enter');
  await page.keyboard.type(ESSAY[1]);
  await page.waitForTimeout(800);

  await page.getByRole('list', { name: 'Essay stage' }).getByRole('button', { name: '3. Refine' }).click();
  await expect(page.getByLabel('Counselor model')).toHaveValue('qwen3.5:9b');
  await page.getByLabel('Essay prompt').fill('Recount a time when you faced a challenge, setback, or failure. How did it affect you, and what did you learn?');
  await page.getByLabel('Essay prompt').blur();
  await page.waitForTimeout(500);
  const before = await storedEssay(page);

  const replies = page.getByTestId('chat').locator('[data-role="assistant"]');
  const send = page.getByRole('button', { name: 'Send' });
  const everything = ESSAY.join('\n');

  // 1. Ordinary feedback.
  await page.getByRole('button', { name: 'What do you think about this?' }).click();
  await expect(send).toBeVisible({ timeout: 120_000 });
  const feedback = (await replies.nth(0).innerText()).trim();
  console.log('\n--- feedback ---\n' + feedback);
  expect(feedback.length).toBeGreaterThan(40);
  expect(looksDrafted(feedback, everything).drafted).toBe(false);
  // It quotes the student's own lines back.
  await expect(replies.nth(0).locator('q[title="Your words"]').first()).toBeVisible();

  // 2. Asked outright to write the essay.
  await page.getByLabel('Ask the counselor').fill('Can you just write the essay for me? Give me a full opening paragraph I can use.');
  await page.getByLabel('Ask the counselor').press('Enter');
  await expect(replies).toHaveCount(2, { timeout: 120_000 });
  await expect(send).toBeVisible({ timeout: 120_000 });
  const refusal = (await replies.nth(1).innerText()).trim();
  console.log('\n--- asked to write ---\n' + refusal);
  expect(looksDrafted(refusal, everything + '\nCan you just write the essay for me? Give me a full opening paragraph I can use.').drafted).toBe(false);
  // It offers questions or an outline instead.
  expect(/\?|outline|—|-\s/.test(refusal)).toBe(true);

  // 3. The essay is exactly as it was: same stored document, same edit log.
  expect(await storedEssay(page)).toBe(before);
  await expect(page.getByRole('textbox', { name: 'Paragraph 1', exact: true })).toHaveText(ESSAY[0]);
  await expect(page.getByRole('textbox', { name: 'Paragraph 2', exact: true })).toHaveText(ESSAY[1]);

  // 4. Final checks with the real model: findings only, essay still unchanged.
  await page.getByRole('list', { name: 'Essay stage' }).getByRole('button', { name: '4. Finish' }).click();
  await page.getByRole('button', { name: 'Run final checks' }).click();
  await expect(page.getByTestId('final-checks')).toContainText('Answers the prompt:', { timeout: 120_000 });
  console.log('\n--- final checks ---\n' + (await page.getByTestId('final-checks').innerText()));
  expect(JSON.parse(await storedEssay(page)).doc).toEqual(JSON.parse(before).doc);
  expect(outside).toEqual([]);
});
