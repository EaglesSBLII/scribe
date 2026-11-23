import { defineConfig } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Phone tests: the real local helper with syncing and sign-in switched on,
// a "Mac" browser and a phone-sized browser that arrives the way a phone does
// (through a forwarding tunnel, so it must sign in). Needs ./setup.sh to have run.
const data = fs.mkdtempSync(path.join(os.tmpdir(), 'scribe-phone-'));

export default defineConfig({
  testDir: 'tests/phone',
  workers: 1,
  reporter: 'list',
  timeout: 120_000,
  use: {
    baseURL: 'http://127.0.0.1:4312',
    browserName: 'chromium',
    permissions: ['microphone'],
    launchOptions: {
      args: [
        '--use-fake-ui-for-media-stream',
        '--use-fake-device-for-media-stream',
        `--use-file-for-fake-audio-capture=${path.resolve(import.meta.dirname, 'tests/fixtures/dock.wav')}%noloop`,
      ],
    },
  },
  webServer: {
    command: 'node ../local/server.js --no-open',
    env: { SCRIBE_PORT: '4312', SCRIBE_DATA: data },
    url: 'http://127.0.0.1:4312/api/health',
    reuseExistingServer: false,
  },
});
