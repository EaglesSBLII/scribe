import { defineConfig } from '@playwright/test';
import path from 'node:path';

// Live tests: the real local helper, the real Whisper, and a recording played
// into the browser as if it were the microphone. Needs ./setup.sh to have run.
const withRecording = (file: string) => ({
  launchOptions: {
    args: [
      '--use-fake-ui-for-media-stream',
      '--use-fake-device-for-media-stream',
      `--use-file-for-fake-audio-capture=${path.resolve(import.meta.dirname, 'tests/fixtures', file)}%noloop`,
    ],
  },
});

export default defineConfig({
  testDir: 'tests/live',
  workers: 1,
  reporter: 'list',
  timeout: 120_000,
  use: {
    baseURL: 'http://127.0.0.1:4311',
    browserName: 'chromium',
    permissions: ['microphone'],
  },
  projects: [
    { name: 'dictation', testMatch: /dictation\.spec/, use: withRecording('dock.wav') },
    { name: 'commands', testMatch: /commands\.spec/, use: withRecording('commands.wav') },
    // These two also need Ollama running with the default model.
    { name: 'assist', testMatch: /assist\.spec/, use: withRecording('assist.wav') },
    { name: 'counselor', testMatch: /counselor\.spec/ },
    { name: 'grading', testMatch: /grading\.spec/ },
    { name: 'voice', testMatch: /voice\.spec/ },
    { name: 'math', testMatch: /math\.spec/, use: withRecording('math.wav') },
    { name: 'wake', testMatch: /wake\.spec/, use: withRecording('wake.wav') },
  ],
  webServer: {
    command: 'node ../local/server.js --no-open',
    env: { SCRIBE_PORT: '4311' },
    url: 'http://127.0.0.1:4311/api/health',
    reuseExistingServer: false,
  },
});
