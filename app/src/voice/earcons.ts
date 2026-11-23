/**
 * Short audio cues, generated in code with Web Audio. There are no sound
 * files: each cue is one or two sine tones with a soft start and end.
 */
import { useSettings } from '../settings';

export type Earcon = 'wake' | 'listenStart' | 'listenStop' | 'applied' | 'confirm' | 'failed' | 'saved' | 'counselor';

export const EARCONS: { id: Earcon; label: string }[] = [
  { id: 'wake', label: 'Wake word heard' },
  { id: 'listenStart', label: 'Listening started' },
  { id: 'listenStop', label: 'Listening stopped' },
  { id: 'applied', label: 'Command applied' },
  { id: 'confirm', label: 'Command needs confirmation' },
  { id: 'failed', label: 'Command failed' },
  { id: 'saved', label: 'Autosaved (at most once a minute)' },
  { id: 'counselor', label: 'Counselor about to speak' },
];

/** Each cue: notes as [frequency in Hz, start in seconds, length in seconds], and a loudness factor. */
const SHAPES: Record<Earcon, { notes: [number, number, number][]; gain: number }> = {
  wake: { notes: [[660, 0, 0.09], [990, 0.08, 0.14]], gain: 1 },
  listenStart: { notes: [[880, 0, 0.12]], gain: 0.8 },
  listenStop: { notes: [[587, 0, 0.14]], gain: 0.8 },
  applied: { notes: [[784, 0, 0.07], [1047, 0.06, 0.09]], gain: 0.7 },
  confirm: { notes: [[740, 0, 0.1], [740, 0.16, 0.1]], gain: 0.9 },
  failed: { notes: [[330, 0, 0.12], [262, 0.11, 0.18]], gain: 0.9 },
  saved: { notes: [[1175, 0, 0.05]], gain: 0.25 },
  counselor: { notes: [[523, 0, 0.1]], gain: 0.6 },
};

const SAVED_EVERY_MS = 60_000;
let context: AudioContext | null = null;
let lastSaved = 0;
/** For tests and for the settings screen: the cues played, newest last. */
export const played: Earcon[] = [];

if (typeof window !== 'undefined') (window as unknown as { __scribeEarcons: Earcon[] }).__scribeEarcons = played;

/** The shared audio context. Browsers (iOS above all) only let it start from a tap. */
export function audioContext(): AudioContext | null {
  if (typeof AudioContext === 'undefined') return null;
  context ??= new AudioContext();
  return context;
}

/** Call from the first tap or click, so sound is allowed afterwards. */
export function unlockAudio() {
  const ctx = audioContext();
  if (ctx && ctx.state === 'suspended') void ctx.resume();
}

export function playEarcon(id: Earcon, opts: { force?: boolean } = {}) {
  const { earconVolume, earconsOff } = useSettings.getState();
  if (!opts.force && (earconVolume <= 0 || earconsOff.includes(id))) return;
  if (id === 'saved') {
    const now = Date.now();
    if (now - lastSaved < SAVED_EVERY_MS) return;
    lastSaved = now;
  }
  played.push(id);
  if (played.length > 50) played.shift();
  const ctx = audioContext();
  if (!ctx) return;
  if (ctx.state === 'suspended') void ctx.resume();
  const shape = SHAPES[id];
  const volume = Math.min(1, Math.max(0, opts.force ? Math.max(earconVolume, 0.4) : earconVolume)) * 0.25 * shape.gain;
  for (const [frequency, start, length] of shape.notes) {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    const t0 = ctx.currentTime + start;
    osc.type = 'sine';
    osc.frequency.value = frequency;
    // A soft attack and release, so there is no click.
    gain.gain.setValueAtTime(0, t0);
    gain.gain.linearRampToValueAtTime(volume, t0 + 0.012);
    gain.gain.linearRampToValueAtTime(0, t0 + length);
    osc.connect(gain).connect(ctx.destination);
    osc.start(t0);
    osc.stop(t0 + length + 0.02);
  }
}
