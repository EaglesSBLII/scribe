// Runs whisper.cpp's whisper-server on this machine and talks to it over 127.0.0.1.
// Used by both the web helper (server.js) and the desktop app's main process.
//
// One copy of the model, asked in one of two ways:
//   full   exact; used for everything that becomes essay text
//   quick  with a shorter audio window, about three times faster; used only
//          when asked for, on short clips said to Scribe (the wake word,
//          answers, questions to the counselor), and checked before it is trusted
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');

const DEFAULT_MODEL = 'ggml-large-v3-turbo-q5_0.bin';
const COMMAND_HINT =
  'Jarvis, Scribe voice commands: Insert, Delete, Move paragraph, Replace, Undo, Read back, Word count, New paragraph.';
// The quick way listens to a 10-second window; clips longer than this are heard in full.
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
function instance(bin, model) {
  let child = null;
  let ready = null;
  let base = '';

  function start() {
    if (ready) return ready;
    ready = (async () => {
      const port = await freePort();
      base = `http://127.0.0.1:${port}`;
      child = spawn(bin, ['-m', model, '--host', '127.0.0.1', '--port', String(port), '-l', 'en', '-sns'], {
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

  async function infer(wav, audioCtx = '0') {
    await start();
    const form = new FormData();
    form.append('file', new Blob([wav], { type: 'audio/wav' }), 'audio.wav');
    form.append('response_format', 'verbose_json');
    form.append('temperature', '0.0');
    // A vocabulary hint, so a command word that opens a sentence is not dropped.
    form.append('prompt', COMMAND_HINT);
    form.append('audio_ctx', audioCtx);
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

/** A transcript the quick copy should not be trusted on: a repeated sentence, or more words than fit in the clip. */
function looksWrong(text, seconds) {
  const sentences = text
    .split(/[.!?\n]+/)
    .map((s) => s.toLowerCase().replace(/[^a-z0-9' ]/g, ' ').replace(/\s+/g, ' ').trim())
    .filter(Boolean);
  for (let i = 1; i < sentences.length; i++) {
    if (sentences[i] === sentences[i - 1] && sentences[i].split(' ').length >= 2) return true;
  }
  const count = text.trim().split(/\s+/).filter(Boolean).length;
  return count > 3 + seconds * 6;
}

function createWhisper(resourcesDir, modelName = process.env.SCRIBE_WHISPER_MODEL || DEFAULT_MODEL) {
  const bin = path.join(resourcesDir, 'bin', 'whisper-server');
  const model = path.join(resourcesDir, 'models', modelName);
  const engine = instance(bin, model);

  function available() {
    return fs.existsSync(bin) && fs.existsSync(model);
  }

  async function start() {
    if (!available()) throw new Error('Whisper is not installed. Run ./setup.sh first.');
    await engine.start();
  }

  /** wav: Buffer of 16 kHz mono WAV. Returns { text, words: [{ text, start, end, p }], quality: { noSpeech, logprob } }. */
  async function transcribe(wav, { quick: wantQuick = false } = {}) {
    if (!available()) throw new Error('Whisper is not installed. Run ./setup.sh first.');
    const seconds = Math.max(0, wav.length - 44) / 32000;
    let data = null;
    if (wantQuick && seconds <= QUICK_MAX_SECONDS) {
      data = await engine.infer(wav, QUICK_AUDIO_CTX);
      // The quick way sometimes repeats itself on a short clip; then it is heard in full.
      if (looksWrong(data.text ?? '', seconds)) data = null;
    }
    data ??= await engine.infer(wav);
    const words = [];
    for (const seg of data.segments ?? []) {
      if (Array.isArray(seg.words) && seg.words.length) {
        for (const w of seg.words) {
          const last = words.at(-1);
          // Whisper reports word pieces; one without a leading space continues the word before it.
          if (last && !/^\s/.test(w.word)) {
            last.text += w.word;
            last.end = w.end;
            if (typeof w.probability === 'number') last.p = Math.min(last.p ?? 1, w.probability);
          } else {
            words.push({ text: w.word.trim(), start: w.start, end: w.end, p: typeof w.probability === 'number' ? w.probability : undefined });
          }
        }
      } else if (seg.text) {
        words.push({ text: seg.text, start: seg.start, end: seg.end });
      }
    }
    // How sure Whisper was, so a stretch of noise it "heard" words in can be told from speech.
    const segs = data.segments ?? [];
    const quality = segs.length
      ? {
          noSpeech: Math.max(...segs.map((x) => x.no_speech_prob ?? 0)),
          logprob: segs.reduce((n, x) => n + (x.avg_logprob ?? 0), 0) / segs.length,
        }
      : { noSpeech: 1, logprob: -10 };
    return { text: (data.text ?? '').trim(), words, quality };
  }

  function stop() {
    engine.stop();
  }

  return { available, start, transcribe, stop, model: modelName };
}

module.exports = { createWhisper, looksWrong };
