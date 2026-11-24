import { expect, test } from '@playwright/test';

// The recording says, with pauses between:
//   "The boat was gone."  "We tried again."
//   "Insert I was nervous between sentences one and two."
//   "Word count."  "Delete the last sentence."

test('spoken commands edit the essay through real Whisper', async ({ page }) => {
  await page.goto('/');
  await page.getByLabel('Your email').fill('writer@example.com');
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.getByRole('navigation').getByRole('button', { name: 'New essay' }).click();
  const para = page.getByRole('textbox', { name: 'Paragraph 1', exact: true });
  const chip = page.getByTestId('command-chip');

  await page.getByRole('button', { name: 'Start dictation' }).click();
  await expect(para).toHaveText('The boat was gone. We tried again.', { timeout: 40_000 });

  // The parsed operation is shown first, then applied.
  // (The preview is on screen for under half a second now, so either wording counts.)
  await expect(chip).toHaveText(/Insert(ing|ed) after P1·S1/, { timeout: 30_000 });
  await expect(para).toHaveText('The boat was gone. I was nervous. We tried again.', { timeout: 10_000 });
  await expect(chip).toHaveText(/Inserted after P1·S1/);

  // The count is computed in code and shown (and spoken).
  await expect(chip).toHaveText('10 words.', { timeout: 30_000 });
  await expect(page.getByTestId('word-count')).toHaveText('10 words');

  // One sentence goes without a dialog, and one tap brings it back.
  await expect(chip).toHaveText(/Deleted P1·S3/, { timeout: 40_000 });
  await expect(para).toHaveText('The boat was gone. I was nervous.');
  await expect(page.getByRole('alertdialog')).toHaveCount(0);
  await chip.getByRole('button', { name: 'Undo' }).click();
  await expect(para).toHaveText('The boat was gone. I was nervous. We tried again.');

  // None of the command words ended up in the essay.
  await expect(para).not.toContainText(/insert|word count|delete/i);
});
