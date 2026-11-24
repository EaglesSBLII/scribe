import { expect, test } from '@playwright/test';

// The recording says: "um, so I, uh, went to the the dock. I love boats, period.
// The Jurassic period was huge."

test('speech becomes clean text in the essay, with nothing leaving this machine', async ({ page }) => {
  const outside: string[] = [];
  await page.route('**/*', (route) => {
    const url = route.request().url();
    if (url.startsWith('http://127.0.0.1:')) return route.continue();
    outside.push(url);
    return route.abort();
  });

  await page.goto('/');
  await page.getByLabel('Your email').fill('writer@example.com');
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.getByRole('navigation').getByRole('button', { name: 'New essay' }).click();

  await page.getByRole('button', { name: 'Start dictation' }).click();
  await expect(page.getByRole('button', { name: 'Stop dictation' })).toBeVisible();
  // Rough text appears while the speaker is still talking.
  await expect(page.getByTestId('interim')).toBeVisible({ timeout: 20_000 });

  const para = page.getByRole('textbox', { name: 'Paragraph 1', exact: true });
  await expect(para).toHaveText('So I went to the dock. I love boats. The Jurassic period was huge.', { timeout: 60_000 });
  // How long after the speaker stops does the text land? (Reported; the recording has three sentences.)
  const waits = await page.evaluate(() => (window as unknown as { __scribeVoice: { dictated: { speechEnd: number; written: number }[] } }).__scribeVoice.dictated.map((d) => Math.round(d.written - d.speechEnd)));
  console.log(`\nDICTATION: text in the essay ${waits.join(', ')} ms after each sentence ended`);
  await page.getByRole('button', { name: 'Stop dictation' }).click();

  // It was saved like any other edit, and one undo takes it back out.
  await page.reload();
  await expect(para).toHaveText('So I went to the dock. I love boats. The Jurassic period was huge.');
  await page.getByRole('button', { name: 'Undo' }).click();
  await expect(para).toHaveText('');
  expect(outside).toEqual([]);
});
