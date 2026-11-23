import { expect, test } from '@playwright/test';

// Coach mode. The recording says "Jarvis, coach mode.", then dictates three
// sentences of an essay, then falls silent. After about six seconds of
// silence the counselor should speak up briefly, without being asked, and
// without touching the essay.

test('coach mode: the counselor speaks up at a pause, and only then', async ({ page }) => {
  test.setTimeout(180_000);
  await page.goto('/');
  await page.getByLabel('Your email').fill('writer@example.com');
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.getByRole('navigation').getByRole('button', { name: 'New essay' }).click();
  const para = page.getByRole('textbox', { name: 'Paragraph 1', exact: true });

  await page.getByRole('button', { name: 'Start dictation' }).click();
  await expect(page.getByTestId('command-chip')).toContainText('Coach mode', { timeout: 60_000 });

  // The three sentences are dictated into the essay as usual.
  await expect(para).toContainText('notebook', { timeout: 60_000 });
  const dictated = (await para.innerText()).trim();
  expect(dictated).toMatch(/^The summer I turned sixteen/);
  // While the student was still talking, the counselor said nothing.
  await page.getByRole('button', { name: 'Open counselor' }).click();
  const replies = page.getByTestId('chat').locator('[data-role="assistant"]');

  // After the pause, one short remark arrives, unasked.
  await expect(replies).toHaveCount(1, { timeout: 60_000 });
  await expect(page.getByRole('button', { name: 'Send' })).toBeVisible({ timeout: 60_000 });
  const remark = (await replies.first().innerText()).replace(/\s*Useful\s*Not for me\s*$/, '').trim();
  console.log('\n--- coach remark after the pause ---\n' + remark);
  expect(remark.split(/\s+/).length).toBeLessThanOrEqual(70);
  // It was spoken aloud.
  const spokenTurns = await page.evaluate(() => (window as unknown as { __scribeEarcons: string[] }).__scribeEarcons.filter((c) => c === 'counselor').length);
  expect(spokenTurns).toBe(1);
  // The essay is exactly what was dictated, and the student's side of the chat is empty.
  await expect(para).toHaveText(dictated);
  await expect(page.getByTestId('chat').locator('[data-role="user"]')).toHaveCount(0);
});
