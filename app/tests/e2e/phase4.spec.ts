import { expect, test } from '@playwright/test';

test('a word limit can be set per essay and is remembered', async ({ page }) => {
  await page.goto('/');
  await page.getByLabel('Your email').fill('writer@example.com');
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.getByRole('navigation').getByRole('button', { name: 'New essay' }).click();
  await page.getByRole('textbox', { name: 'Paragraph 1', exact: true }).click();
  await page.keyboard.type('One two three four five six.');
  await expect(page.getByTestId('word-count')).toHaveText('6 words');

  const limit = page.getByLabel('Word limit');
  await limit.fill('5');
  await limit.press('Enter');
  await expect(page.getByTestId('save-state')).toContainText('Saved');
  await page.waitForTimeout(700);
  await page.reload();
  await expect(page.getByLabel('Word limit')).toHaveValue('5');
  // Over the limit is shown in the warning colour.
  await expect(page.getByLabel('Word limit')).toHaveClass(/text-danger/);

  // The header count uses the same counter as the spoken "word count".
  await page.getByRole('textbox', { name: 'Paragraph 1', exact: true }).press('End');
  await page.keyboard.type(' A well-known shortcut — don\'t.');
  await expect(page.getByTestId('word-count')).toHaveText('10 words');
});
