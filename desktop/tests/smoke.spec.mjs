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
  // The app also serves a phone; give it a port of its own so it cannot collide with a running Scribe.
  const env = { ...process.env, SCRIBE_PORT: '4313' };
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

  // The voice is made on this Mac, by the app itself.
  const voice = await page.evaluate(async () => {
    const info = await window.scribeBridge.ttsInfo();
    if (!info.available) return { available: false };
    const wavBytes = new Uint8Array(await window.scribeBridge.ttsSpeak('Ready when you are.', info.defaultVoice));
    return { available: true, bytes: wavBytes.length, head: String.fromCharCode(...wavBytes.slice(0, 4)) };
  });
  expect(voice).toMatchObject({ available: true, head: 'RIFF' });
  expect(voice.bytes).toBeGreaterThan(20_000);

  // Syncing keeps a master copy through the app, and the phone server answers on this Mac only.
  const synced = await page.evaluate(() =>
    window.scribeBridge.syncExchange({ email: 'writer@example.com', since: 0, push: [{ coll: 'memory', key: 'm1', value: { text: 'x' }, updatedAt: 1 }] }),
  );
  expect(synced.accepted).toEqual(['memory|m1']);
  // The app has been syncing on its own as well: the essay typed above is already in the master copy.
  expect(synced.rev).toBeGreaterThanOrEqual(1);
  expect(await page.evaluate(() => window.scribeBridge.remoteStatus('writer@example.com'))).toEqual({ enabled: false });
  expect(await (await fetch('http://127.0.0.1:4313/api/session')).json()).toEqual({ local: true });
  // Another device is refused until phone access is switched on.
  expect((await fetch('http://127.0.0.1:4313/api/health', { headers: { 'X-Forwarded-For': '100.64.0.2' } })).status).toBe(403);

  // Requests to anywhere else are refused by the app itself.
  const blocked = await page.evaluate(() => fetch('https://example.com').then(() => 'reached', () => 'blocked'));
  expect(blocked).toBe('blocked');

  await app.close();
});
