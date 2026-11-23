// Local text-to-speech: Kokoro, run on this machine with sherpa-onnx.
// Used by the web helper (server.js) and the desktop app's main process.
// Nothing is sent anywhere; the model is a file on disk.
//
// Synthesis runs in a worker thread, so the counselor's reply keeps streaming
// while a sentence is being turned into sound.
const fs = require('node:fs');
const path = require('node:path');
const { Worker, isMainThread, parentPort, workerData } = require('node:worker_threads');

// Speaker numbers in the kokoro-en-v0_19 model.
const VOICES = {
  af: 0, af_bella: 1, af_nicole: 2, af_sarah: 3, af_sky: 4, am_adam: 5, am_michael: 6, bf_emma: 7, bf_isabella: 8, bm_george: 9, bm_lewis: 10,
};
const DEFAULT_VOICE = 'af_bella';
const modelDir = (resourcesDir) => path.join(resourcesDir, 'models', 'tts', 'kokoro-en-v0_19');

function wav(samples, rate) {
  // A short fade at each end, so sentences join without a click.
  const fade = Math.min(Math.floor(rate * 0.008), Math.floor(samples.length / 2));
  const pcm = Buffer.alloc(samples.length * 2);
  for (let i = 0; i < samples.length; i++) {
    let s = samples[i];
    if (i < fade) s *= i / fade;
    else if (i >= samples.length - fade) s *= (samples.length - 1 - i) / fade;
    s = Math.max(-1, Math.min(1, s));
    pcm.writeInt16LE(Math.round(s < 0 ? s * 0x8000 : s * 0x7fff), i * 2);
  }
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVEfmt ', 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

if (!isMainThread && workerData && workerData.scribeTts) {
  // ---- worker: owns the model ----
  const dir = workerData.dir;
  const sherpa = require('sherpa-onnx-node');
  const engine = new sherpa.OfflineTts({
    model: {
      kokoro: {
        model: path.join(dir, 'model.onnx'),
        voices: path.join(dir, 'voices.bin'),
        tokens: path.join(dir, 'tokens.txt'),
        dataDir: path.join(dir, 'espeak-ng-data'),
      },
      numThreads: 4,
      provider: 'cpu',
      debug: false,
    },
    maxNumSentences: 1,
  });
  parentPort.postMessage({ ready: true });
  parentPort.on('message', ({ id, text, voice, speed }) => {
    try {
      const began = performance.now();
      // enableExternalBuffer off: the Mac app (Electron) does not allow memory handed over from native code, so the samples are copied.
      const audio = engine.generate({ text: String(text).slice(0, 1200), sid: VOICES[voice] ?? VOICES[DEFAULT_VOICE], speed: speed || 1.0, enableExternalBuffer: false });
      const out = wav(audio.samples, audio.sampleRate);
      parentPort.postMessage({ id, wav: out, seconds: audio.samples.length / audio.sampleRate, ms: performance.now() - began });
    } catch (err) {
      parentPort.postMessage({ id, error: String(err && err.message ? err.message : err) });
    }
  });
}

function createTts(resourcesDir) {
  const dir = modelDir(resourcesDir);
  let worker = null;
  let ready = null;
  let nextId = 1;
  const waiting = new Map();

  function available() {
    return fs.existsSync(path.join(dir, 'model.onnx'));
  }

  function start() {
    if (ready) return ready;
    ready = new Promise((resolve, reject) => {
      if (!available()) return reject(new Error('The voice is not installed. Run ./setup.sh first.'));
      worker = new Worker(__filename, { workerData: { scribeTts: true, dir }, stderr: true });
      worker.stderr.resume(); // the library prints a harmless notice on load
      worker.once('error', (err) => { ready = null; reject(err); });
      worker.on('message', (m) => {
        if (m.ready) return resolve();
        const job = waiting.get(m.id);
        if (!job) return;
        waiting.delete(m.id);
        if (m.error) job.reject(new Error(m.error));
        else job.resolve({ wav: Buffer.from(m.wav), seconds: m.seconds, ms: m.ms });
      });
      worker.unref();
    });
    return ready;
  }

  /** One sentence or short passage -> { wav: Buffer (16-bit mono, 24 kHz), seconds, ms }. */
  async function synth(text, voice = DEFAULT_VOICE, speed = 1.0) {
    await start();
    return new Promise((resolve, reject) => {
      const id = nextId++;
      waiting.set(id, { resolve, reject });
      worker.postMessage({ id, text, voice, speed });
    });
  }

  function stop() {
    if (worker) void worker.terminate();
    worker = null;
    ready = null;
  }

  return { available, start, synth, stop, voices: Object.keys(VOICES), defaultVoice: DEFAULT_VOICE };
}

module.exports = { createTts };
