import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: 'tests/e2e',
  // The tests change IndexedDB state, so they run one at a time.
  workers: 1,
  fullyParallel: false,
  reporter: 'list',
  use: {
    baseURL: 'http://127.0.0.1:4317',
    browserName: 'chromium',
  },
  webServer: {
    command: 'npm run preview',
    url: 'http://127.0.0.1:4317',
    reuseExistingServer: false,
  },
});
