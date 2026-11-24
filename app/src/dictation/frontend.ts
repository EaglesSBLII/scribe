/**
 * What happens to microphone sound before speech is looked for in it.
 * Pure arithmetic, so the same code runs in the app and in the measurements.
 */

/**
 * Removes the low rumble that wind and traffic put into a microphone outdoors.
 * A voice has almost nothing below about 100 Hz, so nothing said is lost.
 * (A second-order high-pass filter; it remembers its state between blocks.)
 */
export function makeHighPass(cutoffHz = 110, rate = 16000): (input: Float32Array) => Float32Array {
  const w = (2 * Math.PI * cutoffHz) / rate;
  const alpha = Math.sin(w) / (2 * Math.SQRT1_2);
  const cos = Math.cos(w);
  const a0 = 1 + alpha;
  const b0 = (1 + cos) / 2 / a0;
  const b1 = -(1 + cos) / a0;
  const b2 = b0;
  const a1 = (-2 * cos) / a0;
  const a2 = (1 - alpha) / a0;
  let x1 = 0;
  let x2 = 0;
  let y1 = 0;
  let y2 = 0;
  return (input) => {
    const out = new Float32Array(input.length);
    for (let i = 0; i < input.length; i++) {
      const x = input[i];
      const y = b0 * x + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
      x2 = x1;
      x1 = x;
      y2 = y1;
      y1 = y;
      out[i] = y;
    }
    return out;
  };
}

export interface Quality {
  /** Whisper's own estimate that there was no speech (0 to 1). */
  noSpeech: number;
  /** Average log-probability of what it wrote; closer to 0 is surer. */
  logprob: number;
}

// What Whisper tends to write when it is given noise with no speech in it.
const PHANTOMS = /^(thank you|thanks|thanks for watching|thank you for watching|you|bye|bye bye|okay|ok|so|oh|yeah|hmm|i'm sorry|sorry|please subscribe|subtitles by .*|the end|\.+)$/;

/**
 * Was this "heard" in noise rather than said? True when Whisper itself doubted
 * there was speech, when it was unsure of nearly every word, when the sound has
 * no voice in it, or when a short stock phrase came out with low confidence.
 */
export function looksLikeNoise(heard: { text: string; words: { text: string; p?: number }[]; quality?: Quality }, samples?: Float32Array): boolean {
  const q = heard.quality;
  const ps = heard.words.map((w) => w.p).filter((p): p is number => typeof p === 'number');
  const mean = ps.length ? ps.reduce((a, b) => a + b, 0) / ps.length : 1;
  const plain = heard.text.toLowerCase().replace(/[^a-z' ]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!plain) return true;
  if (q && q.noSpeech > 0.6 && q.logprob < -0.7) return true;
  if (q && q.logprob < -1.1) return true;
  // No pitch anywhere in it (so no vowels), and Whisper was not sure either: wind or traffic.
  // A whisper has no pitch too, which is why being sure of the words is enough to keep it.
  if (samples && mean < 0.85 && voicedShare(samples) < 0.15) return true;
  // A stock phrase with a clear voice in it was really said ("Yeah." in answer to a question).
  if (samples && voicedShare(samples) > 0.5) return false;
  return PHANTOMS.test(plain) && (mean < 0.75 || (q?.noSpeech ?? 0) > 0.35);
}

/**
 * How much of a stretch of sound is a voice, from 0 to 1: the share of its
 * louder moments that have a pitch, as vowels do (the sound repeats itself
 * 80 to 300 times a second). Wind and traffic have no pitch, so a stretch that
 * is only noise scores near zero even when Whisper "heard" a sentence in it.
 */
export function voicedShare(samples: Float32Array, rate = 16000): number {
  const frame = Math.round(rate * 0.03);
  const minLag = Math.floor(rate / 300);
  const maxLag = Math.floor(rate / 80);
  const frames: { energy: number; at: number }[] = [];
  for (let i = 0; i + frame + maxLag <= samples.length; i += frame) {
    let energy = 0;
    for (let j = i; j < i + frame; j++) energy += samples[j] * samples[j];
    frames.push({ energy, at: i });
  }
  if (!frames.length) return 0;
  const loudest = [...frames].sort((a, b) => b.energy - a.energy).slice(0, Math.max(1, Math.ceil(frames.length / 2)));
  let voiced = 0;
  for (const { energy, at } of loudest) {
    if (energy <= 0) continue;
    let best = 0;
    for (let lag = minLag; lag <= maxLag; lag += 2) {
      let cross = 0;
      let other = 0;
      for (let j = at; j < at + frame; j++) {
        cross += samples[j] * samples[j + lag];
        other += samples[j + lag] * samples[j + lag];
      }
      const r = other > 0 ? cross / Math.sqrt(energy * other) : 0;
      if (r > best) best = r;
    }
    if (best > PITCH_CLEAR) voiced++;
  }
  return voiced / loudest.length;
}
const PITCH_CLEAR = 0.45;
