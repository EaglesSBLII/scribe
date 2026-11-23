// Runs whisper.cpp's whisper-server on this machine and talks to it over 127.0.0.1.
// Used by both the web helper (server.js) and the desktop app's main process.
//
// Two copies run side by side from the same model file:
//   full   for anything long (dictation)
//   quick  with a shorter audio window, about three times faster, for short
//          utterances: the wake word, commands and questions to the counselor
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');

const DEFAULT_MODEL = 'ggml-large-v3-turbo-q5_0.bin';
const COMMAND_HINT =
  'Jarvis, Scribe voice commands: Insert, Delete, Move paragraph, Replace, Undo, Read back, Word count, New paragraph.';
// The quick copy listens to a 10-second window; clips longer than this go to the full one.
const QUICK_MAX_SECONDS = 8;
const QUICK_AUDIO_CTX = '512';

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

/** One whisper-server process. */
function instance(bin, model, extraArgs) {
  let child = null;
  let ready = null;
  let base = '';

  function start() {
    if (ready) return ready;
    ready = (async () => {
      const port = await freePort();
      base = `http://127.0.0.1:${port}`;
      child = spawn(bin, ['-m', model, '--host', '127.0.0.1', '--port', String(port), '-l', 'en', '-sns', ...extraArgs], {
        stdio: ['ignore', 'ignore', 'pipe'],
      });
      let stderr = '';
      child.stderr.on('data', (d) => { stderr = (stderr + d).slice(-2000); });
      const exited = new Promise((_, reject) =>
        child.once('exit', (code) => {
          child = null;
          ready = null;
          reject(new Error(`whisper-server stopped (code ${code}). ${stderr}`));
        }),
      );
      exited.catch(() => {});
      const up = (async () => {
        const deadline = Date.now() + 60_000;
        while (Date.now() < deadline) {
          try {
            const res = await fetch(base + '/');
            if (res.ok) return;
          } catch { /* not listening yet */ }
          await new Promise((r) => setTimeout(r, 250));
        }
        throw new Error('whisper-server did not start within 60 seconds.');
      })();
      await Promise.race([up, exited]);
    })();
    ready.catch(() => { ready = null; });
    return ready;
  }

  async function infer(wav) {
    await start();
    const form = new FormData();
    form.append('file', new Blob([wav], { type: 'audio/wav' }), 'audio.wav');
    form.append('response_format', 'verbose_json');
    form.append('temperature', '0.0');
    // A vocabulary hint, so a command word that opens a sentence is not dropped.
    form.append('prompt', COMMAND_HINT);
    const res = await fetch(base + '/inference', { method: 'POST', body: form });
    if (!res.ok) throw new Error(`Whisper failed (${res.status}).`);
    return res.json();
  }

  function stop() {
    if (child) child.kill('SIGTERM');
    child = null;
    ready = null;
  }

  return { start, infer, stop };
}

function createWhisper(resourcesDir, modelName = process.env.SCRIBE_WHISPER_MODEL || DEFAULT_MODEL) {
  const bin = path.join(resourcesDir, 'bin', 'whisper-server');
  const model = path.join(resourcesDir, 'models', modelName);
  const full = instance(bin, model, []);
  const quick = instance(bin, model, ['-ac', QUICK_AUDIO_CTX]);

  function available() {
    return fs.existsSync(bin) && fs.existsSync(model);
  }

  async function start() {
    if (!available()) throw new Error('Whisper is not installed. Run ./setup.sh first.');
    await Promise.all([full.start(), quick.start()]);
  }

  /** wav: Buffer of 16 kHz mono WAV. Returns { text, words: [{ text, start, end }] }. */
  async function transcribe(wav) {
    if (!available()) throw new Error('Whisper is not installed. Run ./setup.sh first.');
    const seconds = Math.max(0, wav.length - 44) / 32000;
    const data = await (seconds <= QUICK_MAX_SECONDS ? quick : full).infer(wav);
    const words = [];
    for (const seg of data.segments ?? []) {
      if (Array.isArray(seg.words) && seg.words.length) {
        for (const w of seg.words) {
          const last = words.at(-1);
          // Whisper reports word pieces; one without a leading space continues the word before it.
          if (last && !/^\s/.test(w.word)) {
            last.text += w.word;
            last.end = w.end;
          } else {
            words.push({ text: w.word.trim(), start: w.start, end: w.end });
          }
        }
      } else if (seg.text) {
        words.push({ text: seg.text, start: seg.start, end: seg.end });
      }
    }
    return { text: (data.text ?? '').trim(), words };
  }

  function stop() {
    full.stop();
    quick.stop();
  }

  return { available, start, transcribe, stop, model: modelName };
}

module.exports = { createWhisper };
