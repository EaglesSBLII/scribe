import { defineConfig } from 'vitest/config';

// Measurements, not unit tests: they run real recordings through real Whisper
// and take minutes. Run with: npm run eval -w app
export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/eval/**/*.eval.ts'],
    testTimeout: 30 * 60 * 1000,
    hookTimeout: 5 * 60 * 1000,
    fileParallelism: false,
  },
});
