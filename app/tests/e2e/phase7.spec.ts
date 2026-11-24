import { expect, test, type Page } from '@playwright/test';

const P1 = 'The summer I turned sixteen, I rebuilt a two-stroke boat engine with my grandfather. It did not start. We had spent eleven days on it, and when he pulled the cord the only sound was the rope snapping back.';
const P2 = 'He laughed and said the mistake was in the notebook, not in my hands. We drained the tank the next morning and started again from step nine.';

const IDS = ['prompt', 'voice', 'detail', 'structure', 'insight', 'mechanics'];

/** One grading run by the stand-in model: a level, and optionally a quote, for each section. */
interface Run {
  levels: number[];
  quotes?: (string | undefined)[];
}
const answer = (levels: number[], quotes: (string | undefined)[] = []): Run => ({ levels, quotes });

type Asked = { messages: { role: string; content: string }[]; options?: Record<string, unknown>; format?: unknown };

async function start(page: Page, runs: Run[], opts: { prompt?: boolean; text?: string[] } = {}) {
  const asked: Asked[] = [];
  const firstCalls: Record<string, number> = {};
  await page.route('**/api/llm/models', (r) => r.fulfill({ json: { models: ['qwen3.5:9b'] } }));
  await page.route('**/api/llm/unload', (r) => r.fulfill({ json: { unloaded: true } }));
  await page.route('**/api/llm/chat', (r) => {
    const body = r.request().postDataJSON() as Asked;
    asked.push(body);
    // Each request grades one section; a request that already holds an answer is the retry for a bad quote.
    const id = /SECTION TO GRADE\n(\w+)/.exec(body.messages.map((m) => m.content).join('\n'))![1];
    const retry = body.messages.some((m) => m.role === 'assistant');
    if (!retry) firstCalls[id] = (firstCalls[id] ?? 0) + 1;
    const run = runs[firstCalls[id] - 1] ?? answer([5, 5, 5, 5, 5, 5]);
    const i = IDS.indexOf(id);
    return r.fulfill({
      contentType: 'text/plain',
      body: JSON.stringify({ level: run.levels[i], quote: run.quotes?.[i] ?? 'It did not start.', reason: `Reason for ${id}.` }),
    });
  });
  await page.goto('/');
  await page.getByLabel('Your email').fill('writer@example.com');
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.getByRole('navigation').getByRole('button', { name: 'New essay' }).click();
  await page.getByRole('textbox', { name: 'Paragraph 1', exact: true }).click();
  const [first, ...rest] = opts.text ?? [P1, P2];
  await page.keyboard.type(first);
  for (const t of rest) {
    await page.keyboard.press('Enter');
    await page.keyboard.type(t);
  }
  if (opts.prompt !== false) {
    await page.getByLabel('College').fill('Common App');
    await page.locator('[role="option"][data-college-id="commonapp"]').click();
    await page.getByLabel('Prompt').selectOption('commonapp-2');
  }
  await page.getByRole('list', { name: 'Essay stage' }).getByRole('button', { name: '3. Refine' }).click();
  await page.getByText('Grade', { exact: true }).click();
  await page.waitForTimeout(600);
  return asked;
}

const storedDoc = (page: Page) =>
  page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve) => {
      const open = indexedDB.open('scribe');
      open.onsuccess = () => resolve(open.result);
    });
    const rows = await new Promise<{ doc: unknown }[]>((resolve) => {
      db.transaction('essays').objectStore('essays').getAll().onsuccess = (e) => resolve((e.target as IDBRequest).result);
    });
    db.close();
    return JSON.stringify(rows[0].doc);
  });

const gradeButton = (page: Page) => page.getByRole('button', { name: 'Grade this draft' });

test('grading gives a score out of 100 with section scores, quoted lines and an honest label', async ({ page }) => {
  const asked = await start(page, [answer([8, 6, 7, 5, 4, 9], ['It did not start.', 'the mistake was in the notebook, not in my hands', 'the rope snapping back'])]);
  const before = await storedDoc(page);
  await gradeButton(page).click();

  // (80*25 + 60*20 + 70*20 + 50*10 + 40*15 + 90*10) / 100 = 66, added up in code.
  await expect(page.getByTestId('grade-total')).toHaveText('66/100');
  await expect(page.getByTestId('grade')).toContainText('Rubric-based estimate, not an admissions decision.');
  const sections = page.getByTestId('grade-section');
  await expect(sections).toHaveCount(6);
  await expect(sections.nth(0)).toContainText('Answers the prompt');
  await expect(sections.nth(0)).toContainText('80/100 · weight 25%');
  await expect(sections.nth(0)).toContainText('P1·S2');
  await expect(sections.nth(1)).toContainText('P2·S1');
  await expect(sections.nth(1).locator('q')).toHaveText('the mistake was in the notebook, not in my hands');

  // One request per section, each built for repeatability and carrying that section's written bands.
  expect(asked).toHaveLength(6);
  for (const a of asked) {
    expect(a.options).toMatchObject({ temperature: 0, seed: 7, top_k: 1 });
    expect(a.messages[2].content.match(/levels \d+-\d+:/g)).toHaveLength(5);
    expect(a.messages[1].content).toContain('The lessons we take from obstacles');
    expect(a.messages[1].content).toContain('[P1·S2] It did not start.');
  }
  // Grading reads the essay; it never changes it.
  expect(await storedDoc(page)).toBe(before);
});

test('the same text graded again gives the same score without asking the model again', async ({ page }) => {
  const asked = await start(page, [answer([8, 6, 7, 5, 4, 9]), answer([2, 2, 2, 2, 2, 2]), answer([9, 9, 9, 9, 9, 9])]);
  await gradeButton(page).click();
  await expect(page.getByTestId('grade-total')).toHaveText('66/100');
  for (let i = 0; i < 2; i++) {
    await gradeButton(page).click();
    await expect(page.getByTestId('grade')).toContainText('Same text as before: same score');
    await expect(page.getByTestId('grade-total')).toHaveText('66/100');
  }
  expect(asked).toHaveLength(6);
  await expect(page.getByTestId('score-history').getByRole('listitem')).toHaveCount(1);

  // Still true after a restart.
  await page.reload();
  await page.getByRole('button', { name: 'Open counselor' }).click();
  await page.getByText('Grade', { exact: true }).click();
  await expect(page.getByTestId('grade-total')).toHaveText('66/100');
  await gradeButton(page).click();
  await expect(page.getByTestId('grade')).toContainText('Same text as before: same score');
  expect(asked).toHaveLength(6);
});

test('score history tracks the essay across drafts', async ({ page }) => {
  const asked = await start(page, [answer([5, 5, 5, 5, 5, 5]), answer([7, 7, 7, 7, 7, 7])]);
  await gradeButton(page).click();
  await expect(page.getByTestId('grade-total')).toHaveText('50/100');

  await page.getByRole('textbox', { name: 'Paragraph 2', exact: true }).press('End');
  await page.keyboard.type(' This time it started.');
  await page.waitForTimeout(700);
  await gradeButton(page).click();
  await expect(page.getByTestId('grade-total')).toHaveText('70/100');
  expect(asked).toHaveLength(12);

  const history = page.getByTestId('score-history');
  await expect(history.getByRole('listitem')).toHaveCount(2);
  await expect(history.getByRole('listitem').first()).toContainText('Draft 2');
  await expect(history.getByRole('listitem').first()).toContainText('70/100');
  await expect(history.getByRole('img')).toHaveAttribute('aria-label', 'Scores across drafts: 50, 70');
  // An earlier draft's grade can be looked at again.
  await history.getByRole('button', { name: /Draft 1/ }).click();
  await expect(page.getByTestId('grade-total')).toHaveText('50/100');
});

test('a score whose quote is not really in the essay is asked for again, then shown as unsupported', async ({ page }) => {
  const bad = answer([6, 6, 6, 6, 6, 6], ['It did not start.', 'It did not start.', 'It did not start.', 'It did not start.', 'I learned that failure builds character']);
  const asked = await start(page, [bad]);
  await gradeButton(page).click();
  await expect(page.getByTestId('grade-total')).toHaveText('60/100');
  // Six sections, plus one second try for the section whose quote was invented.
  expect(asked).toHaveLength(7);
  const retry = asked.find((a) => a.messages.some((m) => m.role === 'assistant'))!;
  expect(retry.messages[2].content).toContain('insight');
  expect(retry.messages.at(-1)!.content).toContain('not an exact line from the ESSAY');
  const insight = page.getByTestId('grade-section').filter({ hasText: 'Insight and reflection' });
  await expect(insight).toContainText('The model did not point to an exact line for this score.');
  await expect(insight).not.toContainText('failure builds character');
});

test('with no prompt the prompt section is left out and the other weights are rescaled', async ({ page }) => {
  const asked = await start(page, [answer([5, 8, 8, 8, 8, 8])], { prompt: false });
  await gradeButton(page).click();
  await expect(page.getByTestId('grade-section')).toHaveCount(5);
  await expect(page.getByTestId('grade-section').filter({ hasText: 'Answers the prompt' })).toHaveCount(0);
  await expect(page.getByTestId('grade')).toContainText('no prompt set, so “Answers the prompt” is not scored');
  await expect(page.getByTestId('grade-total')).toHaveText('80/100');
  expect(asked).toHaveLength(5);
  for (const a of asked) expect(a.messages[2].content).not.toContain('Answers the prompt');
});

test('a draft under 50 words is not graded', async ({ page }) => {
  const asked = await start(page, [], { text: ['Too short to judge.'] });
  await gradeButton(page).click();
  await expect(page.getByRole('alert')).toContainText('Write at least 50 words before grading (4 so far).');
  expect(asked).toHaveLength(0);
});

test('weights set for a college in the admin screen change the score', async ({ page }) => {
  await start(page, [answer([10, 5, 5, 5, 5, 5]), answer([10, 5, 5, 5, 5, 5])]);
  await gradeButton(page).click();
  // Default: 100*25% + 50*75% = 62.5 -> 63
  await expect(page.getByTestId('grade-total')).toHaveText('63/100');

  await page.getByRole('button', { name: 'Colleges and prompts' }).click();
  await page.getByTestId('college-row').filter({ hasText: 'Common App' }).click();
  await page.getByLabel('Answers the prompt').fill('70');
  await page.getByLabel('Answers the prompt').blur();
  await page.waitForTimeout(300);
  await page.getByRole('button', { name: 'Back to essays' }).click();
  await page.getByRole('button', { name: 'Open counselor' }).or(page.getByText('Grade', { exact: true })).first().waitFor();
  if (!(await gradeButton(page).isVisible())) await page.getByText('Grade', { exact: true }).click();
  await gradeButton(page).click();

  // 70 of (70+20+20+10+15+10 = 145) -> 48%; 100*48% + 50*52% = 74
  await expect(page.getByTestId('grade')).toContainText('Weights set for Common App');
  await expect(page.getByTestId('grade-section').first()).toContainText('weight 48%');
  await expect(page.getByTestId('grade-total')).toHaveText('74/100');
});
