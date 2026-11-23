// Launches the real desktop app, with the real local Whisper, and checks the basics.
import { test, expect, _electron as electron } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const desktop = path.resolve(here, '..');
const wav = path.resolve(desktop, '..', 'app', 'tests', 'fixtures', 'dock.wav');

test('desktop app opens, saves an essay, and transcribes with local Whisper', async () => {
  test.setTimeout(120_000);
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'scribe-smoke-'));
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  // SCRIBE_APP=<path to Scribe.app/Contents/MacOS/Scribe> tests the packaged app instead.
  const packaged = process.env.SCRIBE_APP;
  const app = await electron.launch(
    packaged
      ? { executablePath: packaged, args: [`--user-data-dir=${userData}`], env }
      : { args: [desktop, `--user-data-dir=${userData}`], env },
  );
  const page = await app.firstWindow();

  await page.getByLabel('Your email').fill('writer@example.com');
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.getByRole('navigation').getByRole('button', { name: 'New essay' }).click();
  await page.getByRole('textbox', { name: 'Paragraph 1' }).click();
  await page.keyboard.type('Typed in the desktop app.');
  await expect(page.getByTestId('word-count')).toHaveText('5 words');

  // The page reaches Whisper through the preload bridge, not the network.
  expect(await page.evaluate(() => window.scribeBridge.asrAvailable())).toBe(true);
  const bytes = [...fs.readFileSync(wav)];
  const heard = await page.evaluate((b) => window.scribeBridge.asrTranscribe(new Uint8Array(b).buffer), bytes);
  expect(heard.text.toLowerCase()).toContain('went to the');
  expect(heard.text.toLowerCase()).toContain('jurassic period');

  // The counselor model is reached the same way. (Skipped if Ollama is not running.)
  const models = await page.evaluate(() => window.scribeBridge.llmModels().catch(() => []));
  if (models.length) {
    const pieces = await page.evaluate(async (model) => {
      const seen = [];
      const off = window.scribeBridge.onLlmDelta((id, text) => id === 'smoke' && seen.push(text));
      const full = await window.scribeBridge.llmChat('smoke', {
        model,
        options: { temperature: 0, seed: 7, num_predict: 20 },
        messages: [{ role: 'user', content: 'Reply with the single word: ready' }],
      });
      // The pieces travel on a different channel from the final reply, so give them a moment.
      await new Promise((r) => setTimeout(r, 300));
      off();
      return { full, streamed: seen.join('') };
    }, models[0]);
    expect(pieces.full.toLowerCase()).toContain('ready');
    expect(pieces.streamed).toBe(pieces.full);
  }

  // Requests to anywhere else are refused by the app itself.
  const blocked = await page.evaluate(() => fetch('https://example.com').then(() => 'reached', () => 'blocked'));
  expect(blocked).toBe('blocked');

  await app.close();
});
