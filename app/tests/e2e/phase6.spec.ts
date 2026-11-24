import { expect, test, type Page } from '@playwright/test';

async function start(page: Page) {
  const asked: { messages: { content: string }[] }[] = [];
  await page.route('**/api/llm/models', (r) => r.fulfill({ json: { models: ['qwen3.5:9b'] } }));
  await page.route('**/api/llm/chat', (r) => {
    asked.push(r.request().postDataJSON());
    return r.fulfill({ contentType: 'text/plain', body: 'Noted.' });
  });
  await page.goto('/');
  await page.getByLabel('Your email').fill('writer@example.com');
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.getByRole('navigation').getByRole('button', { name: 'New essay' }).click();
  await expect(page.getByRole('textbox', { name: 'Paragraph 1', exact: true })).toBeVisible();
  return asked;
}

const openAdmin = (page: Page) => page.getByRole('button', { name: 'Colleges and prompts' }).click();
const adminRow = (page: Page, name: string) => page.getByTestId('college-row').filter({ hasText: name });

test('an essay is tied to a college and prompt, which sets its prompt, limit and title', async ({ page }) => {
  const asked = await start(page);
  await page.getByLabel('College').fill('UC Berkeley');
  await page.locator('[role="option"][data-college-id="uc-berkeley"]').click();
  await expect(page.getByLabel('Prompt').locator('option')).toHaveCount(9); // 8 questions + "Choose a prompt"
  await page.getByLabel('Prompt').selectOption('uc-piq-5');

  await expect(page.getByLabel('Word limit')).toHaveValue('350');
  await expect(page.getByLabel('Essay title').first()).toHaveValue(/Personal Insight Question 5$/);
  const tab = page.getByTestId('essay-tab');
  await expect(tab).toContainText('Personal Insight Question 5');

  // The counselor is given the prompt and what the school has published, and nothing else.
  await page.getByRole('button', { name: 'Open counselor' }).click();
  await expect(page.getByLabel('Essay prompt')).toHaveValue(/most significant challenge/);
  await page.getByLabel('Ask the counselor').fill('Does this answer the prompt?');
  await page.getByLabel('Ask the counselor').press('Enter');
  await expect(page.getByTestId('chat')).toContainText('Noted.');
  const context = asked[0].messages[1].content;
  expect(context).toContain('most significant challenge');
  expect(context).toContain('UC comprehensive review factors');
  expect(context).toContain('Principles from published admissions guidance');
  expect(context).toContain('Do not add other claims about what it wants');

  await page.waitForTimeout(400);
  await page.reload();
  await expect(page.getByLabel('College')).toHaveValue('UC Berkeley');
  await expect(page.getByLabel('College')).toHaveAttribute('data-college-id', 'uc-berkeley');
  await expect(page.getByLabel('Prompt')).toHaveValue('uc-piq-5');
});

test('schools that could not be confirmed are visibly unverified and nothing is invented for them', async ({ page }) => {
  await start(page);
  await page.getByLabel('College').fill('University of Illinois');
  await page.locator('[role="option"][data-college-id="uiuc"]').click();
  await expect(page.getByTestId('unverified-badge')).toBeVisible();
  await expect(page.getByLabel('Prompt').locator('option')).toHaveText(['No prompts stored']);

  await page.getByLabel('College').fill('University of Pennsylvania');
  await page.locator('[role="option"][data-college-id="penn"]').click();
  await expect(page.getByTestId('unverified-badge')).toHaveCount(0);

  await openAdmin(page);
  await expect(adminRow(page, 'University of Illinois')).toContainText('unverified');
  await expect(adminRow(page, 'University of Pennsylvania')).not.toContainText('unverified');
  await adminRow(page, 'University of Illinois').click();
  await expect(page.getByText('No prompts stored yet.')).toBeVisible();
  await expect(page.getByText('None stored. Scribe does not make these up.')).toBeVisible();
  await expect(page.getByLabel('University of Illinois Urbana-Champaign verified')).not.toBeChecked();
});

test('admin: add a school and a prompt, edit them, and keep them across reloads', async ({ page }) => {
  await start(page);
  await openAdmin(page);
  await page.getByRole('button', { name: 'Add college' }).click();
  await page.getByLabel('College name').fill('Harvey Mudd College');
  await page.getByLabel('College name').blur();
  await page.getByLabel('Applies through').fill('Common App');
  await page.getByLabel('Applies through').blur();
  await page.getByRole('button', { name: 'Add prompt' }).click();
  const card = page.getByTestId('prompt-card');
  await card.getByLabel('Label').fill('Why Mudd');
  await card.getByLabel('Prompt text').fill('What makes this college right for you?');
  await card.getByLabel('Word limit').fill('500');
  await card.getByLabel('Source URL').fill('https://www.hmc.edu/admission/');
  await card.getByLabel('Source URL').blur();
  // New entries start unverified until the user says otherwise.
  await expect(card.getByLabel('Why Mudd verified')).not.toBeChecked();
  await card.getByLabel('Why Mudd verified').check();

  await page.waitForTimeout(300);
  await page.reload();
  await openAdmin(page);
  await adminRow(page, 'Harvey Mudd College').click();
  await expect(page.getByTestId('prompt-card').getByLabel('Prompt text')).toHaveValue('What makes this college right for you?');
  await expect(page.getByTestId('prompt-card').getByLabel('Why Mudd verified')).toBeChecked();

  // It can be chosen for an essay straight away.
  await page.getByRole('button', { name: 'Back to essays' }).click();
  await page.getByLabel('College').fill('Harvey Mudd');
  await page.getByRole('option', { name: /Harvey Mudd College/ }).click();
  await expect(page.getByLabel('Prompt').locator('option')).toContainText(['Choose a prompt', 'Why Mudd (500 words)']);
});

test('admin: updating a prompt for a new cycle survives a newer seed, and deleting asks first', async ({ page }) => {
  await start(page);
  await openAdmin(page);
  await adminRow(page, 'Columbia University').click();
  const cards = page.getByTestId('prompt-card');
  await expect(cards).toHaveCount(6);
  const first = cards.first();
  await first.getByLabel('Prompt text').fill('My updated wording for next cycle.');
  await first.getByLabel('Cycle').fill('2027-28');
  await first.getByLabel('Cycle').blur();
  await page.waitForTimeout(300);

  // Pretend a newer seed arrives: edited entries must be kept, untouched ones refreshed.
  await page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve) => {
      const open = indexedDB.open('scribe');
      open.onsuccess = () => resolve(open.result);
    });
    await new Promise((resolve) => (db.transaction('meta', 'readwrite').objectStore('meta').put({ key: 'seedVersion', value: 'older' }).onsuccess = resolve));
    db.close();
  });
  await page.reload();
  await openAdmin(page);
  await adminRow(page, 'Columbia University').click();
  await expect(cards.first().getByLabel('Prompt text')).toHaveValue('My updated wording for next cycle.');
  await expect(cards.first().getByLabel('Cycle')).toHaveValue('2027-28');
  await expect(cards).toHaveCount(6);

  // Deleting a prompt shows what will go, and Cancel keeps it.
  await cards.first().getByRole('button', { name: /^Delete prompt/ }).click();
  await expect(page.getByRole('alertdialog')).toContainText('My updated wording for next cycle.');
  await page.getByRole('alertdialog').getByRole('button', { name: 'Cancel' }).click();
  await expect(cards).toHaveCount(6);
  await cards.first().getByRole('button', { name: /^Delete prompt/ }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Delete', exact: true }).click();
  await expect(cards).toHaveCount(5);
});

test('"what great essays do" lists short sourced principles and can be added to', async ({ page }) => {
  await start(page);
  await openAdmin(page);
  const items = page.getByTestId('principle');
  await expect(items.first()).toBeVisible();
  const before = await items.count();
  expect(before).toBeGreaterThanOrEqual(10);
  await expect(items.first().getByLabel('Source URL')).toHaveValue(/^https:\/\//);

  await page.getByRole('button', { name: 'Add principle' }).click();
  await expect(items).toHaveCount(before + 1);
  await items.last().getByLabel('Principle', { exact: true }).fill('Read it aloud before you submit.');
  await items.last().getByLabel('Principle', { exact: true }).blur();
  await page.waitForTimeout(300);
  await page.reload();
  await openAdmin(page);
  await expect(page.getByTestId('principle')).toHaveCount(before + 1);
});
