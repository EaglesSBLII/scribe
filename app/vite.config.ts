/// <reference types="vitest/config" />
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

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

/**
 * Writes sw.js with the list of files in this build, so the app can be kept
 * on a phone and opened with no connection. Hand-written; no extra dependency.
 */
function serviceWorker(): Plugin {
  const here = (name: string) => fileURLToPath(new URL(name, import.meta.url));
  return {
    name: 'scribe-service-worker',
    apply: 'build',
    generateBundle(_options, bundle) {
      const files = [
        ...Object.keys(bundle).filter((f) => !f.endsWith('.map') && f !== 'index.html'),
        ...fs.readdirSync(here('./public')).filter((f) => !f.startsWith('.')),
      ].map((f) => `./${f}`);
      const build = createHash('sha1').update(Object.keys(bundle).sort().join('|')).digest('hex').slice(0, 10);
      const source = fs.readFileSync(here('./sw.template.js'), 'utf8').replace('__FILES__', JSON.stringify(files)).replace('__BUILD__', build);
      this.emitFile({ type: 'asset', fileName: 'sw.js', source });
    },
  };
}

export default defineConfig({
  // Relative base so the same bundle loads from file:// inside the desktop app.
  base: './',
  plugins: [react(), tailwindcss(), localOnlyCsp(), serviceWorker()],
  // In development the local helper (npm start) provides speech-to-text.
  server: { proxy: { '/api': 'http://127.0.0.1:4310' } },
  // The preview server is what the browser tests run against. It must never reach a real Scribe
  // on this Mac: tests would sync their essays into it.
  preview: { proxy: {} },
  test: {
    environment: 'node',
    include: ['tests/unit/**/*.test.ts'],
  },
});
