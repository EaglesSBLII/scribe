// Serves the built web app on 127.0.0.1 and gives it local speech-to-text.
// Nothing here ever connects to another machine.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { createWhisper } = require('./whisper.js');
const ollama = require('./ollama.js');
const { createTts } = require('./tts.js');

const ROOT = path.resolve(__dirname, '..');
const DIST = path.join(ROOT, 'app', 'dist');
const PORT = Number(process.env.SCRIBE_PORT || 4310);
const MAX_AUDIO_BYTES = 20 * 1024 * 1024;

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf',
  '.wasm': 'application/wasm', '.ico': 'image/x-icon',
};

const whisper = createWhisper(path.join(ROOT, 'desktop', 'resources'));
const tts = createTts(path.join(ROOT, 'desktop', 'resources'));

function send(res, status, body, type = 'application/json') {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(type === 'application/json' ? JSON.stringify(body) : body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_AUDIO_BYTES) {
        reject(new Error('Audio is too large.'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  // Only this machine's own pages may use the helper.
  const host = (req.headers.host || '').split(':')[0];
  if (host !== '127.0.0.1' && host !== 'localhost') return send(res, 403, { error: 'Local use only.' });
  const url = new URL(req.url, `http://${req.headers.host}`);

  try {
    if (url.pathname === '/api/health') {
      return send(res, 200, { asr: whisper.available(), asrModel: whisper.model, tts: tts.available(), voices: tts.voices, defaultVoice: tts.defaultVoice });
    }
    if (url.pathname === '/api/tts' && req.method === 'POST') {
      const { text, voice, speed } = JSON.parse((await readBody(req)).toString('utf8'));
      const audio = await tts.synth(String(text ?? ''), voice, speed);
      res.writeHead(200, { 'Content-Type': 'audio/wav', 'Cache-Control': 'no-store', 'X-Synth-Ms': String(Math.round(audio.ms)) });
      return res.end(audio.wav);
    }
    if (url.pathname === '/api/llm/models') {
      return send(res, 200, { models: await ollama.models().catch(() => []) });
    }
    if (url.pathname === '/api/llm/unload' && req.method === 'POST') {
      const { model } = JSON.parse((await readBody(req)).toString('utf8'));
      return send(res, 200, { unloaded: await ollama.unload(String(model)) });
    }
    if (url.pathname === '/api/llm/chat' && req.method === 'POST') {
      const request = JSON.parse((await readBody(req)).toString('utf8'));
      const abort = new AbortController();
      res.on('close', () => abort.abort());
      // The reply is passed along as plain text while it is being written.
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
      try {
        await ollama.chat(request, (delta) => res.write(delta), abort.signal);
      } catch (err) {
        if (err.name !== 'AbortError') res.write(`\n\u0000ERROR ${err.message}`);
      }
      return res.end();
    }
    if (url.pathname === '/api/asr' && req.method === 'POST') {
      const wav = await readBody(req);
      return send(res, 200, await whisper.transcribe(wav));
    }
    if (url.pathname.startsWith('/api/')) return send(res, 404, { error: 'Not found.' });

    const rel = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname.slice(1));
    const file = path.join(DIST, rel);
    if (!file.startsWith(DIST + path.sep) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      return send(res, 404, 'Not found', 'text/plain');
    }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  } catch (err) {
    send(res, 500, { error: err.message });
  }
});

if (!fs.existsSync(path.join(DIST, 'index.html'))) {
  console.error('The app has not been built yet. Run ./setup.sh (or npm run build) first.');
  process.exit(1);
}

server.listen(PORT, '127.0.0.1', () => {
  const address = `http://127.0.0.1:${PORT}`;
  console.log(`Scribe is running at ${address}  (Ctrl+C to stop)`);
  if (whisper.available()) whisper.start().then(() => console.log('Speech engine ready.'), (e) => console.error(e.message));
  else console.log('Speech engine not installed; dictation is off. Run ./setup.sh to add it.');
  // Load the voice now, so the first thing Scribe says is not slow.
  if (tts.available()) tts.synth('Ready.').then(() => console.log('Voice ready.'), (e) => console.error(e.message));
  else console.log('Voice not installed; Scribe will stay silent. Run ./setup.sh to add it.');
  if (!process.argv.includes('--no-open')) spawn('open', [address], { stdio: 'ignore' }).on('error', () => {});
});

function shutdown() {
  whisper.stop();
  tts.stop();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 500).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
