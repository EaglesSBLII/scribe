// Before packaging: copy the built web app and the local-services code into the
// desktop folder, the same way Chilaka copies app/dist into desktop/web.
const fs = require('node:fs');
const path = require('node:path');

const desktop = path.resolve(__dirname, '..');
const dist = path.resolve(desktop, '..', 'app', 'dist');
const local = path.resolve(desktop, '..', 'local');

if (!fs.existsSync(path.join(dist, 'index.html'))) {
  console.error('Build the app first: npm run build');
  process.exit(1);
}
fs.cpSync(dist, path.join(desktop, 'web'), { recursive: true, force: true });
fs.mkdirSync(path.join(desktop, 'lib'), { recursive: true });
for (const file of ['whisper.js', 'ollama.js', 'tts.js', 'remote.js', 'server.js']) fs.copyFileSync(path.join(local, file), path.join(desktop, 'lib', file));
console.log('Copied app/dist to desktop/web and the local services to desktop/lib');
