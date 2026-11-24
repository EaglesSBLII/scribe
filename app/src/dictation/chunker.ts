/**
 * Splits a live microphone stream into stretches of speech, closing one
 * whenever the speaker pauses. Pure logic, so it can be tested without a mic.
 */

import { makeHighPass } from './frontend';

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
  /**
   * The original way of telling speech from background, which assumes a quiet
   * room. Kept so the two can be measured side by side.
   */
  classic?: boolean;
  /** This speaker's usual level, if it is already known from earlier (see `voiceLevel`). */
  startVoice?: number;
}

const FRAME = 480; // 30 ms
const PRE_ROLL_FRAMES = 15; // 450 ms kept from before speech was detected
const START_FRAMES = 3; // 90 ms of sound before it counts as speech
const MIN_THRESHOLD = 0.012;
// Outdoor detection (see frame()). Levels here are measured above 250 Hz.
const MIN_BAND = 0.004;
const START_OVER_NOISE = 1.7;
const STAY_OVER_NOISE = 1.4;
const START_OF_VOICE = 0.08;
// A whole stretch whose loudest moments stay under this share of the speaker's usual level
// is someone else nearby, or the speaker's voice far from the microphone: it is not passed on.
const STRETCH_OF_VOICE = 0.3;
const STAY_OF_VOICE = 0.15;
const FLOOR_RISE = 1.015;

export class Chunker {
  private pending = new Float32Array(0);
  private preRoll: Float32Array[] = [];
  private speech: Float32Array[] = [];
  private speaking = false;
  private loudRun = 0;
  private quietFrames = 0;
  private framesSinceInterim = 0;
  private noise = 0.004;
  /** How loud this speaker's own voice usually is. */
  private voice = 0;
  private first = true;
  /** The louder moments of the stretch being heard, and the speaker's level when it began. */
  private peak = 0;
  private voiceAtStart = 0;
  private voiceBand = makeHighPass(250, SAMPLE_RATE);
  private opts: Required<Pick<ChunkerOptions, 'endSilence' | 'maxLength' | 'interimEvery'>> & ChunkerOptions;

  constructor(opts: ChunkerOptions = {}) {
    this.opts = { endSilence: 0.9, maxLength: 28, interimEvery: 1.5, ...opts };
    this.voice = opts.startVoice ?? 0;
  }

  /** How loud this speaker's own voice usually is, as learned so far (0 when not yet known). */
  get voiceLevel(): number {
    return this.voice;
  }

  /** Change how long a pause ends an utterance (shorter while waiting for the wake word). */
  setEndSilence(seconds: number) {
    this.opts.endSilence = seconds;
  }

  /** Change how long a pause must be before transcription starts early. */
  setEarlyQuiet(seconds: number) {
    this.opts.earlyQuiet = seconds;
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
    let loud: boolean;
    if (this.opts.classic) {
      loud = rms > Math.max(MIN_THRESHOLD, this.noise * 3);
      // Follow the room's background level, but only from quiet frames.
      if (!loud) this.noise = this.noise * 0.95 + rms * 0.05;
    } else {
      // Outdoors the background is loud and keeps changing, and most of it (wind, engines)
      // is low rumble. So loudness is judged in the range where a voice carries.
      const band = this.voiceBand(f);
      let bandSum = 0;
      for (const v of band) bandSum += v * v;
      const level = Math.sqrt(bandSum / band.length);
      if (this.first) {
        this.first = false;
        this.noise = Math.max(level, 0.0005);
      }
      // Speech must stand clear of the background to start a stretch, and less clear to
      // keep one going. It must also be a fair fraction of this speaker's own usual
      // level, so that quieter voices nearby do not count as the writer talking.
      const need = this.speaking ? Math.max(this.noise * STAY_OVER_NOISE, this.voice * STAY_OF_VOICE) : Math.max(this.noise * START_OVER_NOISE, this.voice * START_OF_VOICE);
      loud = level > Math.max(MIN_BAND, need);
      // The background is the quietest recent sound. It drops at once and creeps up, so
      // steady noise becomes the floor within a few seconds, while a voice, which dips
      // between syllables, does not.
      this.noise = level < this.noise ? this.noise * 0.85 + level * 0.15 : Math.min(level, this.noise * FLOOR_RISE);
      // The speaker's level follows the louder moments of a stretch: up quickly, down slowly,
      // and not at all from sound far below it (that is someone else, or the background).
      if (this.speaking && level > this.peak) this.peak = this.peak * 0.7 + level * 0.3;
      if (loud && this.speaking) {
        if (level > this.voice) this.voice = this.voice ? this.voice * 0.9 + level * 0.1 : level;
        else if (level > this.voice * 0.5) this.voice = this.voice * 0.995 + level * 0.005;
      } else if (!this.speaking) this.voice *= 0.9997;
    }

    if (!this.speaking) {
      this.preRoll.push(f);
      if (this.preRoll.length > PRE_ROLL_FRAMES) this.preRoll.shift();
      this.loudRun = loud ? this.loudRun + 1 : 0;
      if (this.loudRun >= START_FRAMES) {
        this.speaking = true;
        this.peak = 0;
        this.voiceAtStart = this.voice;
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
    // A long stretch is closed at a shorter pause, so text keeps arriving while someone talks on.
    const long = this.opts.classic ? 1 : seconds(this.speech.length) > 14 ? 0.3 : seconds(this.speech.length) > 8 ? 0.5 : 1;
    // (Closed that way it is not the end of a sentence, so it is reported as cut, not paused.)
    if (seconds(this.quietFrames) >= this.opts.endSilence * long) return this.close(long === 1);
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
    if (!this.opts.classic && this.voiceAtStart > 0 && this.peak < this.voiceAtStart * STRETCH_OF_VOICE) {
      // Too quiet to be this speaker: let whoever is listening know the stretch came to nothing.
      // If it was the speaker after all (a quieter microphone, a lowered voice), the level
      // comes down with each stretch set aside, so at most one or two are lost.
      this.voice *= 0.6;
      this.opts.onChunk?.(new Float32Array(0), paused, quietSeconds);
      return;
    }
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
