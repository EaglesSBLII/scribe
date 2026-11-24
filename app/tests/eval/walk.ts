/** Background sounds for the "dictating on a walk" measurements, made the same way every time. */
import path from 'node:path';
import { EVAL_DIR, readWav } from './audio';

export const DIR = path.join(EVAL_DIR, 'noise');
export const RATE = 16000;
/** Background alone, before and after the speech. */
export const LEAD = 15 * RATE;

/** Repeatable random numbers. */
function random(seed: number) {
  let s = seed >>> 0;
  return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296) * 2 - 1;
}
export const rms = (x: Float32Array) => Math.sqrt(x.reduce((n, v) => n + v * v, 0) / x.length);

/** Low rumble that swells and fades, like wind across a microphone. */
export function wind(n: number): Float32Array {
  const r = random(7);
  const out = new Float32Array(n);
  let low = 0;
  let lower = 0;
  for (let i = 0; i < n; i++) {
    low += 0.02 * (r() - low); // about 50 Hz and below
    lower += 0.004 * (r() - lower);
    const gust = 0.35 + 0.65 * Math.max(0, Math.sin(i / (RATE * 1.7)) * Math.sin(i / (RATE * 0.43)));
    out[i] = (low + lower * 2) * gust;
  }
  return out;
}

/** Broad, steady noise with more low than high in it, like a road. */
export function street(n: number): Float32Array {
  const r = random(11);
  const out = new Float32Array(n);
  let b0 = 0;
  let b1 = 0;
  let b2 = 0;
  for (let i = 0; i < n; i++) {
    const w = r();
    b0 = 0.99765 * b0 + w * 0.099046;
    b1 = 0.963 * b1 + w * 0.2965164;
    b2 = 0.57 * b2 + w * 1.0526913;
    const d = ((i / RATE) % 9) - 4.5;
    const pass = 1 + 0.6 * Math.exp(-d * d); // a car going by now and then
    out[i] = (b0 + b1 + b2 + w * 0.1848) * pass;
  }
  return out;
}

/** Three other people talking at once. */
export function others(n: number): Float32Array {
  const out = new Float32Array(n);
  for (const k of [1, 2, 3]) {
    const v = readWav(path.join(DIR, `other-${k}.wav`));
    for (let i = 0; i < n; i++) out[i] += v[(i + k * 31000) % v.length];
  }
  return out;
}

export function mix(speech: Float32Array, noise: Float32Array | null, snrDb: number): Float32Array {
  const out = new Float32Array(speech.length + 2 * LEAD);
  out.set(speech, LEAD);
  if (!noise) return out;
  const gain = rms(speech) / rms(noise) / 10 ** (snrDb / 20);
  for (let i = 0; i < out.length; i++) out[i] = Math.max(-1, Math.min(1, out[i] + noise[i] * gain));
  return out;
}


export function cases(n: number): [string, Float32Array | null, number][] {
  return [
    ['quiet room', null, 0],
    ['wind, as loud as the voice', wind(n), 0],
    ['wind, twice as loud as the voice', wind(n), -6],
    ['street, voice 10 dB above', street(n), 10],
    ['street, voice 5 dB above', street(n), 5],
    ['people talking, voice 15 dB above', others(n), 15],
    ['people talking, voice 10 dB above', others(n), 10],
  ];
}
