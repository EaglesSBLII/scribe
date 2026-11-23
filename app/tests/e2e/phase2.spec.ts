import { expect, test, type Page } from '@playwright/test';

// Every test starts in a fresh browser profile, so the database starts empty.

const para = (page: Page, n: number) => page.getByRole('textbox', { name: `Paragraph ${n}`, exact: true });
const paragraphs = (page: Page) => page.getByTestId('paragraph').getByRole('textbox');
const dialog = (page: Page) => page.getByRole('alertdialog');

async function signUp(page: Page) {
  await page.goto('/');
  await page.getByLabel('Your email').fill('writer@example.com');
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page.getByRole('navigation', { name: 'Essays' })).toBeVisible();
}

async function newEssay(page: Page) {
  await page.getByRole('navigation').getByRole('button', { name: 'New essay' }).click();
  await expect(para(page, 1)).toBeVisible();
}

/** Type paragraphs separated by Enter into the last paragraph. */
async function write(page: Page, ...texts: string[]) {
  await paragraphs(page).last().click();
  for (const [i, text] of texts.entries()) {
    if (i > 0) await page.keyboard.press('Enter');
    await page.keyboard.type(text);
  }
}

test('account is created once from an email and remembered', async ({ page }) => {
  await page.goto('/');
  await page.getByLabel('Your email').fill('not-an-email');
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page.getByRole('alert')).toHaveText('Enter a valid email address.');

  await page.getByLabel('Your email').fill('Writer@Example.com');
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page.getByText('writer@example.com')).toBeVisible();

  await page.reload();
  await expect(page.getByText('writer@example.com')).toBeVisible();
  await expect(page.getByLabel('Your email')).toHaveCount(0);
});

test('typing is saved within 2 seconds and survives a reload', async ({ page }) => {
  await signUp(page);
  await newEssay(page);
  await write(page, 'I went to the dock. The boat was gone.');
  await page.waitForTimeout(1500);
  await page.reload();
  await expect(para(page, 1)).toHaveText('I went to the dock. The boat was gone.');
  await expect(page.getByTestId('word-count')).toHaveText('9 words');
});

test('Enter splits a paragraph and Backspace joins it back without asking', async ({ page }) => {
  await signUp(page);
  await newEssay(page);
  await write(page, 'First one.', 'Second one.');
  await expect(paragraphs(page)).toHaveCount(2);
  await expect(para(page, 2)).toHaveText('Second one.');

  await page.keyboard.press('Home');
  await page.keyboard.press('Backspace');
  await expect(paragraphs(page)).toHaveCount(1);
  await expect(para(page, 1)).toHaveText('First one. Second one.');
  await expect(dialog(page)).toHaveCount(0);
});

test('deleting a paragraph asks first, shows what goes, and undo restores it', async ({ page }) => {
  await signUp(page);
  await newEssay(page);
  await write(page, 'Alpha stays.', 'Bravo will be deleted.', 'Charlie stays.');
  await expect(paragraphs(page)).toHaveCount(3);

  await page.getByRole('button', { name: 'Delete paragraph 2' }).click();
  await expect(dialog(page)).toBeVisible();
  await expect(page.getByTestId('confirm-items')).toHaveText('Bravo will be deleted.');

  // Cancel changes nothing.
  await dialog(page).getByRole('button', { name: 'Cancel' }).click();
  await expect(paragraphs(page)).toHaveCount(3);

  await page.getByRole('button', { name: 'Delete paragraph 2' }).click();
  await dialog(page).getByRole('button', { name: 'Delete', exact: true }).click();
  await expect(paragraphs(page)).toHaveCount(2);
  await expect(para(page, 2)).toHaveText('Charlie stays.');

  await page.getByRole('button', { name: 'Undo' }).click();
  await expect(paragraphs(page)).toHaveCount(3);
  await expect(para(page, 2)).toHaveText('Bravo will be deleted.');

  // The confirmed deletion left a version behind.
  await page.getByRole('button', { name: 'Version history' }).click();
  await expect(page.getByTestId('version').first()).toContainText('Before a large deletion');
});

test('erasing several sentences by hand also asks, and Cancel puts them back', async ({ page }) => {
  await signUp(page);
  await newEssay(page);
  const text = 'One sentence. Two sentences. Three sentences.';
  await write(page, text);
  await expect(page.getByTestId('save-state')).toContainText('Saved');
  await page.waitForTimeout(700);

  await page.keyboard.press('ControlOrMeta+A');
  await page.keyboard.press('Backspace');
  await expect(dialog(page)).toBeVisible();
  await expect(page.getByTestId('confirm-items')).toContainText('Two sentences.');
  await dialog(page).getByRole('button', { name: 'Cancel' }).click();
  await expect(para(page, 1)).toHaveText(text);
});

test('the undo stack survives a reload and has no fixed limit', async ({ page }) => {
  await signUp(page);
  await newEssay(page);
  const lines = Array.from({ length: 12 }, (_, i) => `Line ${i + 1}.`);
  await write(page, ...lines);
  await expect(paragraphs(page)).toHaveCount(12);
  await page.waitForTimeout(700);
  await page.reload();
  await expect(paragraphs(page)).toHaveCount(12);

  const undo = page.getByRole('button', { name: 'Undo' });
  while (await undo.isEnabled()) await undo.click();
  await expect(paragraphs(page)).toHaveCount(1);
  await expect(para(page, 1)).toHaveText('');

  const redo = page.getByRole('button', { name: 'Redo' });
  while (await redo.isEnabled()) await redo.click();
  await expect(paragraphs(page)).toHaveCount(12);
  await expect(para(page, 12)).toHaveText('Line 12.');
});

test('essay tabs: rename, reorder, archive, and delete with confirmation', async ({ page }) => {
  await signUp(page);
  const tabs = page.getByTestId('essay-tab');
  for (const title of ['Common App', 'UC PIQ 1']) {
    await newEssay(page);
    await page.getByRole('button', { name: 'Options for Untitled essay' }).click();
    await page.getByRole('menuitem', { name: 'Rename' }).click();
    await page.getByRole('navigation').getByLabel('Essay title').fill(title);
    await page.keyboard.press('Enter');
  }
  await expect(tabs).toHaveText([/Common App/, /UC PIQ 1/]);
  await write(page, 'My PIQ answer.');
  await expect(tabs.nth(1)).toContainText('3 words');

  await page.getByRole('button', { name: 'Options for UC PIQ 1' }).click();
  await page.getByRole('menuitem', { name: 'Move up' }).click();
  await expect(tabs).toHaveText([/UC PIQ 1/, /Common App/]);

  await page.getByRole('button', { name: 'Options for Common App' }).click();
  await page.getByRole('menuitem', { name: 'Archive' }).click();
  await expect(tabs).toHaveCount(1);
  await page.getByRole('button', { name: 'Archived (1)' }).click();
  await expect(tabs.nth(1)).toContainText('Archived');

  await page.getByRole('button', { name: 'Options for UC PIQ 1' }).click();
  await page.getByRole('menuitem', { name: 'Delete' }).click();
  await expect(dialog(page)).toContainText('Delete "UC PIQ 1"?');
  await expect(page.getByTestId('confirm-items')).toHaveText('My PIQ answer.');
  await dialog(page).getByRole('button', { name: 'Cancel' }).click();
  await expect(tabs.first()).toContainText('UC PIQ 1');

  await page.getByRole('button', { name: 'Options for UC PIQ 1' }).click();
  await page.getByRole('menuitem', { name: 'Delete' }).click();
  await dialog(page).getByRole('button', { name: 'Delete essay' }).click();
  await expect(tabs.filter({ hasText: 'UC PIQ 1' })).toHaveCount(0);

  // Order, archive state and the deletion are all still there after a reload.
  await page.reload();
  await expect(tabs.filter({ hasText: 'UC PIQ 1' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Archived (1)' }).click();
  await expect(tabs).toHaveText([/Common App/]);
});

test('a deleted essay can be brought back from the toast', async ({ page }) => {
  await signUp(page);
  await newEssay(page);
  await write(page, 'Keep me.');
  await page.waitForTimeout(700);
  await page.getByRole('button', { name: 'Options for Untitled essay' }).click();
  await page.getByRole('menuitem', { name: 'Delete' }).click();
  await dialog(page).getByRole('button', { name: 'Delete essay' }).click();
  await expect(page.getByTestId('essay-tab')).toHaveCount(0);
  await page.getByRole('status').getByRole('button', { name: 'Undo' }).click();
  await expect(para(page, 1)).toHaveText('Keep me.');
  await page.reload();
  await expect(para(page, 1)).toHaveText('Keep me.');
});

test('version history: save, change, restore with confirmation, undo the restore', async ({ page }) => {
  await signUp(page);
  await newEssay(page);
  await write(page, 'Original first. Original second. Original third.');
  await page.getByRole('button', { name: 'Save a version' }).click();

  await para(page, 1).click();
  await page.keyboard.press('ControlOrMeta+A');
  await page.keyboard.type('Replaced.');
  await dialog(page).getByRole('button', { name: 'Delete', exact: true }).click();
  await expect(para(page, 1)).toHaveText('Replaced.');

  await page.getByRole('button', { name: 'Version history' }).click();
  const saved = page.getByTestId('version').filter({ hasText: 'Saved by you' });
  await saved.getByRole('button').first().click();
  await saved.getByRole('button', { name: 'Restore this version' }).click();
  await expect(dialog(page)).toContainText('Restore this version?');
  await expect(page.getByTestId('confirm-items')).toHaveText('Replaced.');
  await dialog(page).getByRole('button', { name: 'Restore version' }).click();
  await expect(para(page, 1)).toHaveText('Original first. Original second. Original third.');

  await page.getByRole('button', { name: 'Undo' }).click();
  await expect(para(page, 1)).toHaveText('Replaced.');
});

test('the app makes no request to anything but this machine', async ({ page }) => {
  const outside: string[] = [];
  await page.route('**/*', (route) => {
    const url = route.request().url();
    if (url.startsWith('http://127.0.0.1:') || url.startsWith('data:') || url.startsWith('blob:')) return route.continue();
    outside.push(url);
    return route.abort();
  });
  await signUp(page);
  await newEssay(page);
  await write(page, 'Offline works.', 'Second paragraph.');
  await page.getByRole('button', { name: 'Save a version' }).click();
  await page.getByRole('button', { name: 'Version history' }).click();
  await page.reload();
  await expect(para(page, 1)).toHaveText('Offline works.');
  expect(outside).toEqual([]);

  // The built page also carries a policy that forbids outside connections.
  const csp = await page.locator('meta[http-equiv="Content-Security-Policy"]').getAttribute('content');
  expect(csp).toContain("connect-src 'self' http://127.0.0.1:*");
});
