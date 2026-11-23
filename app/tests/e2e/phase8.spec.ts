import { expect, test, type Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

const essay1 = fs.readFileSync(path.resolve(import.meta.dirname, '../fixtures/essays/essay1.txt'), 'utf8').trim().split(/\n\s*\n/);
const LONG = 'Throughout the entirety of that long and difficult summer I slowly came to appreciate that a plethora of lessons about patience and humility can be found in the process of repairing an engine.';

type Asked = { messages: { role: string; content: string }[] };

async function start(page: Page, replies: string[] = []) {
  const asked: Asked[] = [];
  await page.route('**/api/llm/models', (r) => r.fulfill({ json: { models: ['qwen3.5:9b'] } }));
  await page.route('**/api/llm/chat', (r) => {
    asked.push(r.request().postDataJSON());
    return r.fulfill({ contentType: 'text/plain', body: replies.shift() ?? 'Name the sound the engine made.' });
  });
  await page.goto('/');
  await page.getByLabel('Your email').fill('writer@example.com');
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.getByRole('navigation').getByRole('button', { name: 'New essay' }).click();
  await page.getByRole('textbox', { name: 'Paragraph 1', exact: true }).click();
  for (const [i, para] of essay1.entries()) {
    if (i > 0) await page.keyboard.press('Enter');
    await page.keyboard.insertText(para);
    await page.waitForTimeout(650);
  }
  await expect(page.getByTestId('word-count')).toHaveText('141 words');
  return asked;
}

const refine = (page: Page) => page.getByRole('list', { name: 'Essay stage' }).getByRole('button', { name: '3. Refine' }).click();
const openMemory = (page: Page) => page.getByRole('button', { name: 'My voice and memory' }).click();
const ask = async (page: Page, text: string) => {
  await page.getByLabel('Ask the counselor').fill(text);
  await page.getByLabel('Ask the counselor').press('Enter');
};

test('the voice check points at a line that sounds less like the student, in code, with no model', async ({ page }) => {
  const asked = await start(page);
  await page.getByRole('textbox', { name: 'Paragraph 5', exact: true }).press('End');
  await page.keyboard.press('Enter');
  await page.keyboard.insertText(LONG);
  await page.waitForTimeout(700);
  await refine(page);

  const check = page.getByTestId('voice-check');
  await expect(check.locator('summary')).toHaveText('Voice check (1)');
  await check.locator('summary').click();
  await expect(check).toContainText('P6·S1');
  await expect(check).toContainText('Sounds less like you: it runs 33 words, and your usual sentence is about');
  await expect(check).toContainText('“plethora”, which you do not use anywhere else');
  await expect(check).toContainText('A line that sounds like you:');
  expect(asked).toHaveLength(0);

  // The counselor is told the same thing, and told to protect the student's voice.
  await ask(page, 'What do you think about this?');
  await expect(page.getByTestId('chat')).toContainText('Name the sound the engine made.');
  const context = asked[0].messages[1].content;
  expect(context).toContain("THE STUDENT'S OWN VOICE");
  expect(context).toContain('Lines in this essay that differ from their usual style (measured): P6·S1');
  expect(context).toContain('Never push them toward a more formal, polished or generic style');
});

test('feedback marked useful or not is remembered and given to the counselor next time', async ({ page }) => {
  const asked = await start(page, ['Name the sound the engine made.', 'Open with a famous quotation.', 'Noted.']);
  await refine(page);
  await ask(page, 'What should I include?');
  const replies = page.getByTestId('chat').locator('[data-role="assistant"]');
  await replies.nth(0).getByRole('button', { name: 'Useful' }).click();
  await expect(replies.nth(0).getByRole('button', { name: 'Useful' })).toHaveAttribute('aria-pressed', 'true');

  await ask(page, 'How should I open?');
  await expect(replies).toHaveCount(2);
  await replies.nth(1).getByRole('button', { name: 'Not for me' }).click();
  await page.waitForTimeout(300);

  await ask(page, 'Anything else?');
  await expect(replies).toHaveCount(3);
  const context = asked[2].messages[1].content;
  expect(context).toContain('Advice they found useful before: "Name the sound the engine made."');
  expect(context).toContain('Advice they rejected (do not give it again): "Open with a famous quotation."');

  // It is all visible in the memory screen, survives a reload, and can be changed or deleted.
  await page.reload();
  await openMemory(page);
  const feedback = page.getByTestId('memory-feedback');
  await expect(feedback).toHaveCount(2);
  await expect(feedback.nth(1)).toContainText('Not for me');
  await feedback.nth(1).getByRole('button', { name: 'Delete this feedback note' }).click();
  await expect(feedback).toHaveCount(1);
});

test('memory screen: rhythm and vocabulary are shown, and words can be removed or added', async ({ page }) => {
  await start(page);
  await openMemory(page);
  await expect(page.getByTestId('rhythm')).toContainText('Your sentences average');
  const vocab = page.getByTestId('vocabulary');
  await expect(vocab).toContainText('notebook');

  await vocab.getByRole('button', { name: 'Remove notebook' }).click();
  await expect(vocab).not.toContainText('notebook');
  await page.getByLabel('Add a word').fill('Boatyard');
  await page.getByLabel('Add a word').press('Enter');
  await expect(vocab).toContainText('boatyard');
  await page.waitForTimeout(300);
  await page.reload();
  await openMemory(page);
  await expect(page.getByTestId('vocabulary')).toContainText('boatyard');
  await expect(page.getByTestId('vocabulary')).not.toContainText('notebook');
});

test('tone and story notes come from the model only when backed by the student\'s own words, and can be edited', async ({ page }) => {
  const asked = await start(page, [
    JSON.stringify({
      tone: [
        { note: 'Ends a thought on a short flat line', quote: "I didn't." },
        { note: 'Loves grand statements', quote: 'Failure is the mother of all success' },
      ],
      stories: [
        { essay: 1, title: 'Rebuilding the boat engine', quote: 'We drained the tank the next morning and started again from step 9.' },
        { essay: 1, title: 'Winning the regatta', quote: 'I crossed the finish line first' },
      ],
    }),
  ]);
  await openMemory(page);
  await page.getByRole('button', { name: 'Describe my voice from my essays' }).click();
  const tone = page.getByTestId('memory-tone');
  // The note whose quote is not in the essay was dropped, as was the invented story.
  await expect(tone).toHaveCount(1);
  await expect(tone.getByLabel('Edit tone note')).toHaveValue('Ends a thought on a short flat line');
  await expect(tone).toContainText('Written by the local model from your writing');
  await expect(page.getByTestId('memory-story')).toHaveCount(1);
  await expect(page.getByTestId('memory-story').getByLabel('Edit story note')).toHaveValue('Rebuilding the boat engine');
  expect(asked).toHaveLength(1);
  expect(asked[0].messages[1].content).toContain('It didn\'t start.');

  // Edit one, add one of your own.
  await tone.getByLabel('Edit tone note').fill('I stop short on purpose');
  await tone.getByLabel('Edit tone note').blur();
  await page.getByLabel('Add a note about how you write').fill('I never use semicolons');
  await page.getByLabel('Add a note about how you write').press('Enter');
  await expect(page.getByTestId('memory-tone')).toHaveCount(2);
  await page.waitForTimeout(300);
  await page.reload();
  await openMemory(page);
  await expect(page.getByTestId('memory-tone').getByLabel('Edit tone note').first()).toHaveValue('I stop short on purpose');
});

test('turning memory off, or deleting it, stops it being used', async ({ page }) => {
  const asked = await start(page, ['First.', 'Second.', 'Third.']);
  await openMemory(page);
  await page.getByLabel('Add a note about how you write').fill('I never use semicolons');
  await page.getByLabel('Add a note about how you write').press('Enter');
  await page.getByRole('button', { name: 'Back to essays' }).click();
  await refine(page);
  await ask(page, 'One?');
  await expect(page.getByTestId('chat')).toContainText('First.');
  expect(asked[0].messages[1].content).toContain('I never use semicolons');

  // Off: nothing learned is used, and the voice check and rating buttons go away.
  await openMemory(page);
  await page.getByLabel('Learn from my writing').uncheck();
  await expect(page.getByText('Memory is off.')).toBeVisible();
  await page.getByRole('button', { name: 'Back to essays' }).click();
  await ask(page, 'Two?');
  await expect(page.getByTestId('chat')).toContainText('Second.');
  expect(asked[1].messages[1].content).not.toContain("THE STUDENT'S OWN VOICE");
  await expect(page.getByTestId('voice-check')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Useful' })).toHaveCount(0);

  // Delete everything: asks first, then the notes are gone for good.
  await openMemory(page);
  await page.getByLabel('Learn from my writing').check();
  await page.getByRole('button', { name: 'Delete all memory' }).click();
  await expect(page.getByRole('alertdialog')).toContainText('1 remembered item');
  await page.getByRole('alertdialog').getByRole('button', { name: 'Delete all memory' }).click();
  await expect(page.getByTestId('memory-tone')).toHaveCount(0);
  await expect(page.getByLabel('Learn from my writing')).not.toBeChecked();
  await page.waitForTimeout(300);
  await page.reload();
  await openMemory(page);
  await expect(page.getByTestId('memory-tone')).toHaveCount(0);
  // The essay was never touched by any of this.
  await page.getByRole('button', { name: 'Back to essays' }).click();
  await expect(page.getByTestId('word-count')).toHaveText('141 words');
});

test('memory belongs to the account that made it', async ({ page }) => {
  await start(page);
  await openMemory(page);
  await page.getByLabel('Add a note about how you write').fill('I never use semicolons');
  await page.getByLabel('Add a note about how you write').press('Enter');
  await page.waitForTimeout(300);
  const stored = await page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve) => {
      const open = indexedDB.open('scribe');
      open.onsuccess = () => resolve(open.result);
    });
    const get = <T,>(store: string) => new Promise<T[]>((resolve) => {
      db.transaction(store).objectStore(store).getAll().onsuccess = (e) => resolve((e.target as IDBRequest).result);
    });
    const [accounts, memory] = [await get<{ id: string; email: string }>('accounts'), await get<{ accountId: string; text: string }>('memory')];
    db.close();
    return { accounts, memory };
  });
  expect(stored.accounts).toHaveLength(1);
  expect(stored.memory).toHaveLength(1);
  expect(stored.memory[0].accountId).toBe(stored.accounts[0].id);
});
