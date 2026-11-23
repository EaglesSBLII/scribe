import { expect, test, type Page } from '@playwright/test';
import fs from 'node:fs';

// These tests replace the local model with canned replies, so they run anywhere.
// tests/live/counselor.spec.ts does the same things against real Ollama.

const ESSAY = ['The summer I turned sixteen, I rebuilt a boat engine with my grandfather. It did not start.', 'We tried again the next morning.'];

async function start(page: Page, replies: string[]) {
  const asked: { messages: { role: string; content: string }[]; format?: unknown }[] = [];
  await page.route('**/api/llm/models', (r) => r.fulfill({ json: { models: ['qwen3.5:9b', 'llama3.1:8b'] } }));
  await page.route('**/api/llm/chat', (r) => {
    asked.push(r.request().postDataJSON());
    return r.fulfill({ contentType: 'text/plain', body: replies.shift() ?? 'Tell me more about that.' });
  });
  await page.goto('/');
  await page.getByLabel('Your email').fill('writer@example.com');
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.getByRole('navigation').getByRole('button', { name: 'New essay' }).click();
  await page.getByRole('textbox', { name: 'Paragraph 1', exact: true }).click();
  await page.keyboard.type(ESSAY[0]);
  await page.keyboard.press('Enter');
  await page.keyboard.type(ESSAY[1]);
  await expect(page.getByTestId('word-count')).toHaveText('23 words');
  await page.waitForTimeout(700);
  return asked;
}

/** The essay exactly as stored, for before/after comparison. */
function storedEssay(page: Page) {
  return page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve) => {
      const open = indexedDB.open('scribe');
      open.onsuccess = () => resolve(open.result);
    });
    const rows = await new Promise<{ doc: unknown; wordCount: number }[]>((resolve) => {
      db.transaction('essays').objectStore('essays').getAll().onsuccess = (e) => resolve((e.target as IDBRequest).result);
    });
    const ops = await new Promise<number>((resolve) => {
      db.transaction('ops').objectStore('ops').count().onsuccess = (e) => resolve((e.target as IDBRequest).result);
    });
    db.close();
    return JSON.stringify({ doc: rows[0].doc, words: rows[0].wordCount, ops });
  });
}

const stage = (page: Page, name: string) => page.getByRole('list', { name: 'Essay stage' }).getByRole('button', { name });

test('the stepper moves between stages, remembers the stage and keeps Draft quiet', async ({ page }) => {
  await start(page, []);
  await expect(stage(page, '2. Draft')).toHaveAttribute('aria-current', 'step');
  await expect(page.getByRole('complementary', { name: 'Counselor' })).toHaveCount(0);

  await stage(page, '3. Refine').click();
  await expect(page.getByRole('complementary', { name: 'Counselor' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Does this answer the prompt?' })).toBeVisible();
  await expect(page.getByTestId('essay-tab')).toContainText('Refine');

  await stage(page, '2. Draft').click();
  await expect(page.getByRole('complementary', { name: 'Counselor' })).toHaveCount(0);

  await stage(page, '4. Finish').click();
  await expect(page.getByTestId('save-state')).toContainText('Saved');
  await page.waitForTimeout(300);
  await page.reload();
  await expect(stage(page, '4. Finish')).toHaveAttribute('aria-current', 'step');
  // Each stage change left a version behind.
  await page.getByRole('button', { name: 'Version history' }).click();
  await expect(page.getByTestId('version').first()).toContainText('Moved to Finish');
});

test('acceptance: a counselor conversation leaves the essay byte-for-byte unchanged', async ({ page }) => {
  const asked = await start(page, [
    'Your second line lands: "It did not start." (P1·S2) is short and concrete. What did your grandfather say?',
    'Add what you heard in the garage. For example "the rope snapping back".',
  ]);
  const before = await storedEssay(page);

  await stage(page, '3. Refine').click();
  await page.getByRole('button', { name: 'What do you think about this?' }).click();
  const chat = page.getByTestId('chat');
  await expect(chat.locator('[data-role="assistant"]')).toContainText('Your second line lands');
  // The student's own words are marked as theirs; the model's example is not.
  await expect(chat.locator('q[title="Your words"]')).toHaveText('It did not start.');

  await page.getByLabel('Ask the counselor').fill('What should I include?');
  await page.getByLabel('Ask the counselor').press('Enter');
  await expect(chat.locator('q[title="An example, not your words"]')).toHaveText('the rope snapping back');

  // The model saw the essay with line labels, and the rules that forbid drafting.
  expect(asked[0].messages[0].content).toContain('You never write, rewrite, draft');
  expect(asked[0].messages[1].content).toContain('[P1·S2] It did not start.');

  // Zero AI-authored text in the essay: stored document, word count and edit log are identical.
  expect(await storedEssay(page)).toBe(before);
  await expect(page.getByRole('textbox', { name: 'Paragraph 1', exact: true })).toHaveText(ESSAY[0]);
  // The panel offers no way to put a reply into the essay.
  await expect(page.getByRole('complementary', { name: 'Counselor' }).getByRole('button', { name: /insert|add to essay|use this|apply/i })).toHaveCount(0);

  // The conversation itself is kept.
  await page.reload();
  await page.getByRole('button', { name: 'Open counselor' }).click();
  await expect(page.getByTestId('chat').locator('[data-role="user"]')).toHaveText(['What do you think about this?', 'What should I include?']);
});

test('if the model drafts essay text anyway, the student gets a refusal instead', async ({ page }) => {
  const drafted = 'Sure! Here it is. I spent eleven days in the garage with my grandfather. My hands were black with grease by the end. We pulled the cord together and nothing happened. My heart sank as the rope snapped back.';
  const asked = await start(page, [drafted, drafted]);
  const before = await storedEssay(page);
  await stage(page, '3. Refine').click();
  await page.getByLabel('Ask the counselor').fill('Can you write my essay for me?');
  await page.getByLabel('Ask the counselor').press('Enter');

  const reply = page.getByTestId('chat').locator('[data-role="assistant"]');
  await expect(reply).toContainText("I can't write parts of the essay for you");
  await expect(reply).not.toContainText('eleven days');
  // It was told the student asked for writing, and was given one retry.
  expect(asked).toHaveLength(2);
  expect(asked[0].messages[0].content).toContain('has just asked you to write or rewrite essay text');
  expect(await storedEssay(page)).toBe(before);
});

test('brainstorm: questions, then stories mapped to the prompt in the student\'s own words', async ({ page }) => {
  const asked = await start(page, [
    'What is something you fixed, or tried to fix, that mattered to you?',
    'Tell me more about "it did not start". What did you do next?',
    JSON.stringify({
      stories: [
        { title: 'The engine that failed', quote: 'we rebuilt a boat engine and it did not start', fit: 5, reason: 'It shows how you handle failure.' },
        { title: 'Invented story', quote: 'I won the state championship', fit: 4, reason: 'Not something you said.' },
      ],
    }),
  ]);
  const before = await storedEssay(page);
  await stage(page, '1. Brainstorm').click();
  await page.getByLabel('Essay prompt').fill('Recount a time when you faced a challenge, setback, or failure.');
  await page.getByLabel('Essay prompt').blur();
  await page.getByRole('button', { name: 'Start brainstorm' }).click();
  await expect(page.getByTestId('chat')).toContainText('something you fixed');

  await page.getByLabel('Ask the counselor').fill('With my grandfather we rebuilt a boat engine and it did not start.');
  await page.getByLabel('Ask the counselor').press('Enter');
  await expect(page.getByTestId('chat')).toContainText('What did you do next?');

  await page.getByRole('button', { name: 'Map my stories' }).click();
  const stories = page.getByTestId('stories').getByRole('listitem');
  // The story the model made up is dropped: its quote is not something the student said.
  await expect(stories).toHaveCount(1);
  await expect(stories).toContainText('The engine that failed');
  await expect(stories).toContainText('Fit 5/5');
  expect(asked[2].messages[1].content).toContain('Recount a time when you faced a challenge');
  // Brainstorm answers stay in the panel; the essay is untouched apart from its stage and prompt.
  expect(JSON.parse(await storedEssay(page)).doc).toEqual(JSON.parse(before).doc);
});

test('finish: final checks flag problems without fixing them, and the essay exports', async ({ page }) => {
  await start(page, [
    JSON.stringify({
      verdict: 'partly',
      why: 'You describe the failure but not what changed.',
      quote: 'It did not start.',
      typos: [
        { quote: 'the next morning', issue: 'Check the comma before this phrase.' },
        { quote: 'words that are not in the essay', issue: 'Invented.' },
      ],
    }),
  ]);
  await page.getByLabel('Word limit').fill('20');
  await page.getByLabel('Word limit').press('Enter');
  const before = JSON.parse(await storedEssay(page)).doc;
  await stage(page, '4. Finish').click();
  await page.getByLabel('Essay prompt').fill('Recount a time when you faced a setback.');
  await page.getByLabel('Essay prompt').blur();
  await page.getByRole('button', { name: 'Run final checks' }).click();

  const checks = page.getByTestId('final-checks');
  await expect(checks).toContainText('23 words: 3 over the 20-word limit.');
  await expect(checks).toContainText('Answers the prompt: partly.');
  await expect(checks).toContainText('P2·S1');
  await expect(checks).toContainText('Check the comma before this phrase.');
  // A "typo" the model could not point to in the essay is not shown.
  await expect(checks).not.toContainText('Invented.');
  expect(JSON.parse(await storedEssay(page)).doc).toEqual(before);

  const save = async (label: string) => {
    const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: label, exact: true }).click()]);
    return { name: download.suggestedFilename(), bytes: fs.readFileSync(await download.path()) };
  };
  const txt = await save('.txt');
  expect(txt.name).toBe('Untitled essay.txt');
  expect(txt.bytes.toString('utf8')).toBe(`${ESSAY[0]}\n\n${ESSAY[1]}\n`);
  const docx = await save('.docx');
  expect(docx.bytes.subarray(0, 2).toString()).toBe('PK');
  expect(docx.bytes.length).toBeGreaterThan(2000);
  const pdf = await save('.pdf');
  expect(pdf.bytes.subarray(0, 5).toString()).toBe('%PDF-');
});

test('the model can be switched, and the choice is remembered and used', async ({ page }) => {
  const asked = await start(page, ['Noted.']);
  await stage(page, '3. Refine').click();
  const picker = page.getByLabel('Counselor model');
  await expect(picker).toHaveValue('qwen3.5:9b');
  await picker.selectOption('llama3.1:8b');
  await page.reload();
  await page.getByRole('button', { name: 'Open counselor' }).click();
  await expect(page.getByLabel('Counselor model')).toHaveValue('llama3.1:8b');
  await page.getByLabel('Ask the counselor').fill('Is the ending clear?');
  await page.getByLabel('Ask the counselor').press('Enter');
  await expect(page.getByTestId('chat')).toContainText('Noted.');
  expect((asked[0] as unknown as { model: string }).model).toBe('llama3.1:8b');
});
