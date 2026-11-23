import { expect, test } from '@playwright/test';

// The recording says, with pauses between:
//   "The boat was gone."  "We tried again and again that week."
//   "Delete the last five words."      "Undo."
//   "Nobody spoke."                    "Delete what I just said."
//   "New paragraph."                   "It was cold. It was late."
//   "Delete paragraph two."  ...  "No, keep it."
//   "Delete paragraph two."  ...  "Yes, delete it."

test('smarter scribe by voice: last words, last utterance, undo, and a deletion that waits for "yes"', async ({ page }) => {
  test.setTimeout(240_000);
  await page.goto('/');
  await page.getByLabel('Your email').fill('writer@example.com');
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.getByRole('navigation').getByRole('button', { name: 'New essay' }).click();
  const p1 = page.getByRole('textbox', { name: 'Paragraph 1', exact: true });
  const p2 = page.getByRole('textbox', { name: 'Paragraph 2', exact: true });
  const chip = page.getByTestId('command-chip');
  const dialog = page.getByRole('alertdialog');
  const full = 'The boat was gone. We tried again and again that week.';

  await page.getByRole('button', { name: 'Start dictation' }).click();
  await expect(p1).toHaveText(full, { timeout: 40_000 });

  // "Delete the last five words" removes exactly five.
  await expect(chip).toHaveText(/Deleted the last 5 words of P1/, { timeout: 30_000 });
  await expect(p1).toHaveText('The boat was gone. We tried');
  await expect(page.getByTestId('word-count')).toHaveText('6 words');

  // "Undo" brings them back.
  await expect(p1).toHaveText(full, { timeout: 30_000 });

  // "Delete what I just said" removes exactly the last utterance.
  await expect(p1).toHaveText(`${full} Nobody spoke.`, { timeout: 30_000 });
  await expect(chip).toHaveText(/Deleted what you just said/, { timeout: 30_000 });
  await expect(p1).toHaveText(full);

  // A second paragraph, then asking to delete it: Scribe asks, and waits.
  await expect(p2).toHaveText('It was cold. It was late.', { timeout: 40_000 });
  await expect(dialog).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('confirm-items').locator('p')).toHaveText(['It was cold.', 'It was late.']);
  await expect(chip).toContainText('This will delete: It was cold. It was late. Say “yes, delete it” to confirm');
  // Nothing has been deleted while it waits.
  await expect(p2).toHaveText('It was cold. It was late.');

  // "No, keep it": the dialog closes and the paragraph stays.
  await expect(dialog).toHaveCount(0, { timeout: 40_000 });
  await expect(p2).toHaveText('It was cold. It was late.');

  // Asked again, and this time "Yes, delete it": now it goes.
  await expect(dialog).toBeVisible({ timeout: 40_000 });
  await expect(page.getByRole('textbox', { name: /^Paragraph \d+$/ })).toHaveCount(1, { timeout: 60_000 });
  await expect(p1).toHaveText(full);

  // And undo restores even that.
  await page.getByRole('button', { name: 'Undo' }).click();
  await expect(p2).toHaveText('It was cold. It was late.');
  // No command words were written into the essay.
  await expect(p1).not.toContainText(/delete|undo|keep it/i);
});
