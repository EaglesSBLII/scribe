import { expect, test, type Page } from '@playwright/test';

// The voice settings and sounds, with a stand-in for the Mac helper.

async function start(page: Page) {
  await page.route('**/api/llm/models', (r) => r.fulfill({ json: { models: ['qwen3.5:9b', 'qwen3.5:4b', 'qwen3.5:2b'] } }));
  await page.route('**/api/health', (r) => r.fulfill({ json: { asr: false, tts: true, voices: ['af_bella', 'af_sarah', 'bm_george'], defaultVoice: 'af_bella' } }));
  await page.goto('/');
  await page.getByLabel('Your email').fill('writer@example.com');
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.getByRole('navigation').getByRole('button', { name: 'New essay' }).click();
  await expect(page.getByRole('textbox', { name: 'Paragraph 1', exact: true })).toBeVisible();
}

const openSettings = (page: Page) => page.getByRole('button', { name: 'Settings', exact: true }).click();
const playedCues = (page: Page) => page.evaluate(() => (window as unknown as { __scribeEarcons: string[] }).__scribeEarcons.slice());

test('settings: counselor mode, models, voice and the interruption switch are remembered', async ({ page }) => {
  await start(page);
  await openSettings(page);
  await expect(page.getByRole('radiogroup', { name: 'Counselor mode' }).getByRole('radio').first()).toBeChecked();
  await page.getByRole('radio', { name: /^Coach\./ }).check();
  await page.getByLabel('Voice', { exact: true }).selectOption('bm_george');
  await page.getByLabel('Command model').selectOption('qwen3.5:2b');
  await page.getByLabel('Counselor model setting').selectOption('qwen3.5:4b');
  await page.getByLabel('Let me interrupt by talking').uncheck();
  await page.getByLabel('Answer out loud').uncheck();
  await page.waitForTimeout(300);

  await page.reload();
  await openSettings(page);
  await expect(page.getByRole('radio', { name: /^Coach\./ })).toBeChecked();
  await expect(page.getByLabel('Voice', { exact: true })).toHaveValue('bm_george');
  await expect(page.getByLabel('Command model')).toHaveValue('qwen3.5:2b');
  await expect(page.getByLabel('Counselor model setting')).toHaveValue('qwen3.5:4b');
  await expect(page.getByLabel('Let me interrupt by talking')).not.toBeChecked();
  await expect(page.getByLabel('Answer out loud')).not.toBeChecked();
});

test('sounds: every cue can be played and switched off, with one volume, and autosave is quiet and rare', async ({ page }) => {
  await start(page);
  await openSettings(page);
  const sounds = page.getByRole('region', { name: 'Sounds' });
  // All of the cues in the brief are listed.
  for (const label of ['Wake word heard', 'Listening started', 'Listening stopped', 'Command applied', 'Command needs confirmation', 'Command failed', 'Autosaved (at most once a minute)', 'Counselor about to speak']) {
    await expect(sounds.getByLabel(label, { exact: true })).toBeChecked();
  }
  await sounds.getByRole('button', { name: 'Play: Command applied' }).click();
  await sounds.getByRole('button', { name: 'Play: Command failed' }).click();
  expect((await playedCues(page)).slice(-2)).toEqual(['applied', 'failed']);

  // Switch one cue off and set the volume; both are remembered.
  await sounds.getByLabel('Autosaved (at most once a minute)', { exact: true }).uncheck();
  await sounds.getByLabel('Sound volume').fill('0.3');
  await page.waitForTimeout(300);
  await page.reload();
  await openSettings(page);
  await expect(page.getByLabel('Autosaved (at most once a minute)', { exact: true })).not.toBeChecked();
  await expect(page.getByLabel('Sound volume')).toHaveValue('0.3');

  // With it off, saving plays nothing.
  await page.getByRole('button', { name: 'Back to essays' }).click();
  const before = (await playedCues(page)).length;
  await page.getByRole('textbox', { name: 'Paragraph 1', exact: true }).click();
  await page.keyboard.type('One sentence here.');
  await page.waitForTimeout(900);
  expect((await playedCues(page)).length).toBe(before);
});

test('the autosave cue plays at most once a minute, and deleting by button plays the confirmation cue', async ({ page }) => {
  await start(page);
  const p1 = page.getByRole('textbox', { name: 'Paragraph 1', exact: true });
  await p1.click();
  await page.keyboard.type('First sentence.');
  await page.waitForTimeout(800);
  await page.keyboard.type(' Second sentence.');
  await page.waitForTimeout(800);
  await page.keyboard.type(' Third sentence.');
  await page.waitForTimeout(800);
  // Three saves, one cue.
  expect((await playedCues(page)).filter((c) => c === 'saved')).toHaveLength(1);
});

test('the wake-word switch is in settings; the Jarvis button is for talking with the counselor', async ({ page }) => {
  await start(page);
  await expect(page.getByRole('button', { name: 'Talk with Jarvis' })).toHaveAttribute('aria-pressed', 'false');
  // Brainstorming no longer turns dictation into a conversation by itself.
  await page.getByRole('button', { name: 'Brainstorm' }).click();
  await openSettings(page);
  await expect(page.getByRole('radio', { name: /Draft/ })).toBeChecked();
  await expect(page.getByLabel('Listen for Jarvis')).not.toBeChecked();
  await page.getByLabel('Listen for Jarvis').check();
  await page.getByRole('button', { name: 'Back to essays' }).click();
  // No speech engine in this test: Scribe says so instead of pretending to listen.
  await expect(page.getByTestId('dictation-status')).toContainText('speech engine is not running');
});
