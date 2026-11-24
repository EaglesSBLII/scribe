// Serves the built web app on 127.0.0.1 and gives it local speech-to-text,
// the local model, the local voice, and a master copy for syncing devices.
// It listens on this machine only and never connects to another one. A phone
// reaches it through a private tunnel and must sign in (see remote.js).
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { createWhisper } = require('./whisper.js');
const ollamaDefault = require('./ollama.js');
const { createTts } = require('./tts.js');
const { createRemote } = require('./remote.js');

const MAX_BODY_BYTES = 20 * 1024 * 1024;

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf',
  '.wasm': 'application/wasm', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json',
};

function send(res, status, body, type = 'application/json', headers = {}) {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store', ...headers });
  res.end(type === 'application/json' ? JSON.stringify(body) : body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('That is too large.'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

const readJson = async (req) => JSON.parse((await readBody(req)).toString('utf8') || '{}');

/**
 * Build the request handler.
 *   dist     folder holding the built web app
 *   whisper, tts, ollama   the local engines
 *   remote   sign-in and the sync store (remote.js)
 *   sync     false switches syncing off (used by tests that must start empty)
 */
function createHandler({ dist, whisper, tts, ollama, remote, sync = true }) {
  return async (req, res) => {
    const url = new URL(req.url, 'http://scribe.local');
    const local = remote.isLocal(req);
    const api = url.pathname.startsWith('/api/');
    let session = null;

    try {
      if (!local) {
        // From another device: nothing works until access is switched on at the Mac, and the device has signed in.
        if (!remote.enabled()) return send(res, 403, { error: 'Phone access is off. Turn it on in Scribe’s settings on the Mac.' }, api ? 'application/json' : 'text/plain');
        session = remote.sessionOf(req);
        const secure = req.headers['x-forwarded-proto'] === 'https';
        if (url.pathname === '/api/session') {
          return send(res, 200, { local: false, signedIn: !!session, email: session?.email ?? null });
        }
        if (url.pathname === '/api/login' && req.method === 'POST') {
          const { email, password } = await readJson(req);
          try {
            const made = remote.login(email, password);
            return send(res, 200, { signedIn: true, email: made.email }, 'application/json', { 'Set-Cookie': remote.cookie(made.token, secure) });
          } catch (err) {
            return send(res, 401, { error: err.message });
          }
        }
        if (url.pathname === '/api/logout' && req.method === 'POST') {
          remote.logout(req);
          return send(res, 200, { signedIn: false }, 'application/json', { 'Set-Cookie': remote.cookie(null, secure) });
        }
        if (api && !session) return send(res, 401, { error: 'Sign in first.' });
      } else {
        // A web page from somewhere else, open in a browser on this Mac, must not be able to drive Scribe.
        if (api && req.headers.origin) {
          let from = '';
          try {
            from = new URL(req.headers.origin).hostname;
          } catch { /* not a web origin */ }
          if (from !== '127.0.0.1' && from !== 'localhost') return send(res, 403, { error: 'Local use only.' });
        }
        if (url.pathname === '/api/session') return send(res, 200, { local: true });
        // Phone access is switched on and off from the Mac only.
        if (url.pathname === '/api/remote') {
          if (req.method === 'GET') return send(res, 200, remote.status(url.searchParams.get('email')));
          const { email, password } = await readJson(req);
          if (req.method === 'POST') {
            try {
              remote.setPassword(email, password);
            } catch (err) {
              return send(res, 400, { error: err.message });
            }
            return send(res, 200, remote.status(email));
          }
          if (req.method === 'DELETE') {
            remote.disable(email);
            return send(res, 200, remote.status(email));
          }
        }
      }
      if (url.pathname === '/api/remote') return send(res, 403, { error: 'Only on the Mac.' });

      if (sync && url.pathname === '/api/sync' && req.method === 'POST') {
        const body = await readJson(req);
        // A signed-in device can only reach its own account.
        return send(res, 200, remote.exchange(session ? session.email : body.email, body));
      }
      if (url.pathname === '/api/health') {
        return send(res, 200, { asr: whisper.available(), asrModel: whisper.model, tts: tts.available(), voices: tts.voices, defaultVoice: tts.defaultVoice });
      }
      if (url.pathname === '/api/tts' && req.method === 'POST') {
        const { text, voice, speed } = await readJson(req);
        const audio = await tts.synth(String(text ?? ''), voice, speed);
        res.writeHead(200, { 'Content-Type': 'audio/wav', 'Cache-Control': 'no-store', 'X-Synth-Ms': String(Math.round(audio.ms)) });
        return res.end(audio.wav);
      }
      if (url.pathname === '/api/llm/models') {
        return send(res, 200, { models: await ollama.models().catch(() => []) });
      }
      if (url.pathname === '/api/llm/unload' && req.method === 'POST') {
        const { model } = await readJson(req);
        return send(res, 200, { unloaded: await ollama.unload(String(model)) });
      }
      if (url.pathname === '/api/llm/chat' && req.method === 'POST') {
        const request = await readJson(req);
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
        const quick = url.searchParams.get('quick') === '1';
        const heard = await whisper.transcribe(wav, { quick });
        if (process.env.SCRIBE_DEBUG) {
          const ps = heard.words.map((w) => w.p).filter((p) => typeof p === 'number');
          const mean = ps.length ? ps.reduce((x, y) => x + y, 0) / ps.length : 1;
          console.error(`[asr ${quick ? 'quick' : 'full'} ${((wav.length - 44) / 32000).toFixed(1)}s noSpeech ${heard.quality.noSpeech.toFixed(2)} logprob ${heard.quality.logprob.toFixed(2)} p ${mean.toFixed(2)}] ${heard.text}`);
        }
        return send(res, 200, heard);
      }
      if (api) return send(res, 404, { error: 'Not found.' });

      const rel = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname.slice(1));
      const file = path.join(dist, rel);
      if (!file.startsWith(dist + path.sep) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
        return send(res, 404, 'Not found', 'text/plain');
      }
      // Files with a fingerprint in their name never change; the rest are checked each time.
      const fixed = /^assets\//.test(rel);
      res.writeHead(200, {
        'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream',
        'Cache-Control': fixed ? 'public, max-age=31536000, immutable' : 'no-cache',
      });
      fs.createReadStream(file).pipe(res);
    } catch (err) {
      if (!res.headersSent) send(res, 500, { error: err.message });
      else res.end();
    }
  };
}

/** Start listening on this machine only. Resolves with the server, or rejects if the port is taken. */
function listen(handler, port) {
  return new Promise((resolve, reject) => {
    const server = http.createServer(handler);
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
}

module.exports = { createHandler, listen };

if (require.main === module) {
  const ROOT = path.resolve(__dirname, '..');
  const DIST = path.join(ROOT, 'app', 'dist');
  const PORT = Number(process.env.SCRIBE_PORT || 4310);
  const resources = path.join(ROOT, 'desktop', 'resources');
  const whisper = createWhisper(resources);
  const tts = createTts(resources);
  const remote = createRemote(process.env.SCRIBE_DATA || path.join(ROOT, 'data'));

  if (!fs.existsSync(path.join(DIST, 'index.html'))) {
    console.error('The app has not been built yet. Run ./setup.sh (or npm run build) first.');
    process.exit(1);
  }

  listen(createHandler({ dist: DIST, whisper, tts, ollama: ollamaDefault, remote, sync: !process.env.SCRIBE_NO_SYNC }), PORT).then((server) => {
    const address = `http://127.0.0.1:${PORT}`;
    console.log(`Scribe is running at ${address}  (Ctrl+C to stop)`);
    if (whisper.available()) whisper.start().then(() => console.log('Speech engine ready.'), (e) => console.error(e.message));
    else console.log('Speech engine not installed; dictation is off. Run ./setup.sh to add it.');
    // Load the voice now, so the first thing Scribe says is not slow.
    if (tts.available()) tts.synth('Ready.').then(() => console.log('Voice ready.'), (e) => console.error(e.message));
    else console.log('Voice not installed; Scribe will stay silent. Run ./setup.sh to add it.');
    if (!process.argv.includes('--no-open')) spawn('open', [address], { stdio: 'ignore' }).on('error', () => {});

    function shutdown() {
      whisper.stop();
      tts.stop();
      server.close(() => process.exit(0));
      setTimeout(() => process.exit(0), 500).unref();
    }
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  }, (err) => {
    console.error(err.code === 'EADDRINUSE' ? `Port ${PORT} is in use. Is Scribe already running?` : err.message);
    process.exit(1);
  });
}
