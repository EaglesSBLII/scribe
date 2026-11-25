import { expect, test } from '@playwright/test';

// The recording says, with pauses between:
//   "We tried again."            before the wake word: must be ignored
//   "Jarvis."                    wakes it
//   "The boat was gone."         dictated
//   "My friend called me Jarvis."  dictated; the name here is just a word
//   "Jarvis, word count."        a command, not essay text
//   "Jarvis, stop listening."    back to waiting
//   "Nobody spoke."              after sleeping: must be ignored

test('the wake word: "Jarvis" starts a session, commands need the name, and the name inside a sentence stays text', async ({ page }) => {
  const outside: string[] = [];
  await page.route('**/*', (route) => {
    const url = route.request().url();
    if (url.startsWith('http://127.0.0.1:') || url.startsWith('data:')) return route.continue();
    outside.push(url);
    return route.abort();
  });
  await page.goto('/');
  await page.getByLabel('Your email').fill('writer@example.com');
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.getByRole('navigation').getByRole('button', { name: 'New essay' }).click();
  const para = page.getByRole('textbox', { name: 'Paragraph 1', exact: true });
  const status = page.getByTestId('dictation-status');

  // Switch the wake word on: the microphone opens, but nothing is written down yet.
  await page.getByRole('button', { name: 'Settings' }).click();
  await page.getByLabel('Listen for Jarvis').check();
  await page.getByRole('button', { name: 'Back to essays' }).click();
  await expect(status).toHaveText('Say “Jarvis”');
  await expect(page.getByRole('button', { name: 'Start dictation' })).toBeVisible();

  // "Jarvis" alone starts the session.
  await expect(page.getByRole('button', { name: 'Stop dictation' })).toBeVisible({ timeout: 30_000 });
  // What was said before the wake word was not kept.
  await expect(para).toHaveText('');

  // Dictation, including a sentence with the name in it.
  await expect(para).toHaveText('The boat was gone. My friend called me Jarvis.', { timeout: 40_000 });

  // "Jarvis, word count" is a command: answered, and not typed into the essay.
  await expect(page.getByTestId('command-chip')).toHaveText('9 words.', { timeout: 30_000 });
  await expect(para).toHaveText('The boat was gone. My friend called me Jarvis.');

  // "Jarvis, stop listening" returns to waiting; what is said afterwards is ignored.
  await expect(status).toHaveText('Say “Jarvis”', { timeout: 40_000 });
  await expect(page.getByRole('button', { name: 'Start dictation' })).toBeVisible();
  await page.waitForTimeout(7000);
  await expect(para).toHaveText('The boat was gone. My friend called me Jarvis.');
  await expect(para).not.toContainText(/word count|stop listening|Nobody|tried/i);

  // The wake setting is remembered.
  await page.getByRole('button', { name: 'Settings' }).click();
  await expect(page.getByLabel('Listen for Jarvis')).toBeChecked();
  expect(outside).toEqual([]);
});
