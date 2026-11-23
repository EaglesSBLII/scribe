import { expect, test } from '@playwright/test';

// The recording says: "The boat was gone." "We tried again." "Nobody spoke."
// and then "Take out the second sentence." which is not in the fixed grammar.

test('an edit request in other words is restated by the local model, then applied by the fixed rules', async ({ page }) => {
  await page.goto('/');
  await page.getByLabel('Your email').fill('writer@example.com');
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.getByRole('navigation').getByRole('button', { name: 'New essay' }).click();
  const para = page.getByRole('textbox', { name: 'Paragraph 1', exact: true });

  await page.getByRole('button', { name: 'Start dictation' }).click();
  await expect(para).toHaveText('The boat was gone. We tried again. Nobody spoke.', { timeout: 40_000 });

  const chip = page.getByTestId('command-chip');
  await expect(chip).toHaveText(/Deleted P1·S2/, { timeout: 60_000 });
  await expect(para).toHaveText('The boat was gone. Nobody spoke.');
  await chip.getByRole('button', { name: 'Undo' }).click();
  await expect(para).toHaveText('The boat was gone. We tried again. Nobody spoke.');
});
