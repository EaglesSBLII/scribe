/**
 * Splits a live microphone stream into stretches of speech, closing one
 * whenever the speaker pauses. Pure logic, so it can be tested without a mic.
 */

export const SAMPLE_RATE = 16000;

export interface ChunkerOptions {
  /** Silence that ends a stretch of speech, in seconds. */
  endSilence?: number;
  /** A stretch is cut here even without a pause, in seconds. */
  maxLength?: number;
  /** How often to offer the speech so far for interim text, in seconds. */
  interimEvery?: number;
  onSpeechStart?: () => void;
  onInterim?: (samples: Float32Array) => void;
  /**
   * `paused` is false when the stretch was cut for length, mid-speech.
   * `quietSeconds` is how long ago the speaker actually stopped.
   */
  onChunk?: (samples: Float32Array, paused: boolean, quietSeconds: number) => void;
  /**
   * Called once at the start of each pause, well before it is long enough to
   * end the stretch, so transcription can begin early. If the speaker carries
   * on, it is called again at the next pause with the longer audio.
   */
  onEarly?: (samples: Float32Array) => void;
  /** How long a pause must be before onEarly fires, in seconds. */
  earlyQuiet?: number;
}

const FRAME = 480; // 30 ms
const PRE_ROLL_FRAMES = 10; // 300 ms kept from before speech was detected
const START_FRAMES = 3; // 90 ms of sound before it counts as speech
const MIN_THRESHOLD = 0.012;

export class Chunker {
  private pending = new Float32Array(0);
  private preRoll: Float32Array[] = [];
  private speech: Float32Array[] = [];
  private speaking = false;
  private loudRun = 0;
  private quietFrames = 0;
  private framesSinceInterim = 0;
  private noise = 0.004;
  private opts: Required<Pick<ChunkerOptions, 'endSilence' | 'maxLength' | 'interimEvery'>> & ChunkerOptions;

  constructor(opts: ChunkerOptions = {}) {
    this.opts = { endSilence: 0.9, maxLength: 28, interimEvery: 1.5, ...opts };
  }

  /** Change how long a pause ends an utterance (shorter while waiting for the wake word). */
  setEndSilence(seconds: number) {
    this.opts.endSilence = seconds;
  }

  feed(samples: Float32Array) {
    const all = new Float32Array(this.pending.length + samples.length);
    all.set(this.pending);
    all.set(samples, this.pending.length);
    let i = 0;
    for (; i + FRAME <= all.length; i += FRAME) this.frame(all.slice(i, i + FRAME));
    this.pending = all.slice(i);
  }

  /** The microphone was switched off: hand over whatever speech is in progress. */
  flush() {
    if (this.speaking) this.close(true);
    this.pending = new Float32Array(0);
    this.preRoll = [];
  }

  private frame(f: Float32Array) {
    let sum = 0;
    for (const s of f) sum += s * s;
    const rms = Math.sqrt(sum / f.length);
    const threshold = Math.max(MIN_THRESHOLD, this.noise * 3);
    const loud = rms > threshold;
    // Follow the room's background level, but only from quiet frames.
    if (!loud) this.noise = this.noise * 0.95 + rms * 0.05;

    if (!this.speaking) {
      this.preRoll.push(f);
      if (this.preRoll.length > PRE_ROLL_FRAMES) this.preRoll.shift();
      this.loudRun = loud ? this.loudRun + 1 : 0;
      if (this.loudRun >= START_FRAMES) {
        this.speaking = true;
        this.speech = this.preRoll;
        this.preRoll = [];
        this.quietFrames = 0;
        this.framesSinceInterim = 0;
        this.opts.onSpeechStart?.();
      }
      return;
    }

    this.speech.push(f);
    this.quietFrames = loud ? 0 : this.quietFrames + 1;
    this.framesSinceInterim++;
    const seconds = (n: number) => (n * FRAME) / SAMPLE_RATE;
    if (this.opts.onEarly && this.quietFrames === Math.max(1, Math.round(((this.opts.earlyQuiet ?? 0.2) * SAMPLE_RATE) / FRAME))) {
      this.opts.onEarly(join(this.speech));
    }
    if (seconds(this.quietFrames) >= this.opts.endSilence) return this.close(true);
    if (seconds(this.speech.length) >= this.opts.maxLength) return this.close(false);
    if (seconds(this.framesSinceInterim) >= this.opts.interimEvery) {
      this.framesSinceInterim = 0;
      this.opts.onInterim?.(join(this.speech));
    }
  }

  private close(paused: boolean) {
    const samples = join(this.speech);
    const quietSeconds = (this.quietFrames * FRAME) / SAMPLE_RATE;
    this.speech = [];
    this.speaking = false;
    this.loudRun = 0;
    this.quietFrames = 0;
    this.opts.onChunk?.(samples, paused, quietSeconds);
  }
}

function join(frames: Float32Array[]): Float32Array {
  const out = new Float32Array(frames.reduce((n, f) => n + f.length, 0));
  let at = 0;
  for (const f of frames) {
    out.set(f, at);
    at += f.length;
  }
  return out;
}

/** 16-bit mono WAV at 16 kHz, the format Whisper wants. */
export function encodeWav(samples: Float32Array): ArrayBuffer {
  const buf = new ArrayBuffer(44 + samples.length * 2);
  const v = new DataView(buf);
  const text = (at: number, s: string) => [...s].forEach((c, i) => v.setUint8(at + i, c.charCodeAt(0)));
  text(0, 'RIFF');
  v.setUint32(4, 36 + samples.length * 2, true);
  text(8, 'WAVEfmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, SAMPLE_RATE, true);
  v.setUint32(28, SAMPLE_RATE * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  text(36, 'data');
  v.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    v.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return buf;
}
