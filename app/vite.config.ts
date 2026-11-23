/// <reference types="vitest/config" />
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// Built pages may only talk to this machine. This is what enforces "zero API use".
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "media-src 'self' blob:",
  "worker-src 'self' blob:",
  "connect-src 'self' http://127.0.0.1:*",
].join('; ');

function localOnlyCsp(): Plugin {
  return {
    name: 'scribe-local-only-csp',
    apply: 'build',
    transformIndexHtml: (html) =>
      html.replace(
        '<head>',
        `<head>\n    <meta http-equiv="Content-Security-Policy" content="${CSP}" />`,
      ),
  };
}

export default defineConfig({
  // Relative base so the same bundle loads from file:// inside the desktop app.
  base: './',
  plugins: [react(), tailwindcss(), localOnlyCsp()],
  // In development the local helper (npm start) provides speech-to-text.
  server: { proxy: { '/api': 'http://127.0.0.1:4310' } },
  test: {
    environment: 'node',
    include: ['tests/unit/**/*.test.ts'],
  },
});
