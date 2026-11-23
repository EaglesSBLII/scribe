/**
 * Scribe's voice. Sentences are synthesized on this Mac (Kokoro) and played by
 * the page through Web Audio, one after another, so it starts talking while
 * the rest of a reply is still being written. Playback can be stopped at once
 * when the writer talks over it.
 */
import { create } from 'zustand';
import { platform } from './platform';
import { useSettings } from './settings';
import { audioContext } from './voice/earcons';
import { mark } from './voice/metrics';

interface SpeechState {
  /** Scribe is talking, or about to (a sentence is queued). */
  speaking: boolean;
  /** Sound is coming out right now. */
  audible: boolean;
}

export const useSpeech = create<SpeechState>(() => ({ speaking: false, audible: false }));

interface Item {
  text: string;
  audio: Promise<AudioBuffer | null>;
}

const GAP_SECONDS = 0.14;
const FADE_SECONDS = 0.03;
const REMEMBER_MS = 45_000;

let queue: Item[] = [];
let pumping = false;
let generation = 0;
let current: { source: AudioBufferSourceNode; gain: GainNode } | null = null;
let playbackStartedAt = 0;
/** What Scribe has actually said lately, so its own voice can be recognised if the microphone picks it up. */
const spoken: { text: string; at: number }[] = [];

/** Make text sayable: no markup, and places said in words. */
export function speakable(text: string): string {
  return text
    .replace(/\bP(\d+)·S(\d+)\b/g, 'paragraph $1, sentence $2')
    .replace(/\bP(\d+)\b/g, 'paragraph $1')
    .replace(/https?:\/\/\S+/g, 'a link')
    .replace(/\$\$?[^$]+\$\$?/g, 'a formula')
    .replace(/[*_#`>]+/g, '')
    .replace(/\be\.g\./gi, 'for example')
    .replace(/\bi\.e\./gi, 'that is')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Split text into sentences for speaking. */
export function splitSentences(text: string): string[] {
  return (text.match(/[^.!?…]+[.!?…]+["”')\]]*|[^.!?…]+$/g) ?? []).map((s) => s.trim()).filter(Boolean);
}

/**
 * The pieces a reply is spoken in. Sentences, except that the opening sentence
 * is broken at its first clause (a comma after at least four words), so Scribe
 * can start talking before the whole sentence has been written. The split does
 * not move as more text arrives, so pieces can be counted while streaming.
 */
export function speechUnits(text: string): string[] {
  const sentences = splitSentences(text);
  if (sentences.length === 0) return [];
  const m = /^((?:\S+\s+){3,}?\S+[,;:—–])\s+(\S.*)$/s.exec(sentences[0]);
  return m ? [m[1], m[2], ...sentences.slice(1)] : sentences;
}

async function fetchAudio(text: string): Promise<AudioBuffer | null> {
  const ctx = audioContext();
  if (!ctx) return null;
  try {
    const wav = await platform.ttsSpeak(text, useSettings.getState().voice);
    return await ctx.decodeAudioData(wav.slice(0));
  } catch {
    // No voice installed, or the helper is not running: Scribe stays silent and the text is still on screen.
    return null;
  }
}

function play(buffer: AudioBuffer, mine: number): Promise<void> {
  return new Promise((resolve) => {
    const ctx = audioContext();
    if (!ctx || mine !== generation) return resolve();
    if (ctx.state === 'suspended') void ctx.resume();
    const source = ctx.createBufferSource();
    const gain = ctx.createGain();
    source.buffer = buffer;
    source.connect(gain).connect(ctx.destination);
    current = { source, gain };
    source.onended = () => {
      if (current?.source === source) current = null;
      resolve();
    };
    if (!useSpeech.getState().audible) playbackStartedAt = performance.now();
    useSpeech.setState({ audible: true });
    mark('audioStart');
    source.start();
  });
}

async function pump() {
  if (pumping) return;
  pumping = true;
  const mine = generation;
  while (queue.length && mine === generation) {
    const item = queue.shift()!;
    const buffer = await item.audio;
    if (mine !== generation) break;
    if (!buffer) continue;
    await play(buffer, mine);
    if (mine !== generation) break;
    // It was heard to the end, so it counts as said.
    spoken.push({ text: item.text, at: Date.now() });
    await new Promise((r) => setTimeout(r, GAP_SECONDS * 1000));
  }
  pumping = false;
  if (mine === generation && queue.length === 0) useSpeech.setState({ speaking: false, audible: false });
  else if (queue.length) void pump();
}

/** Queue one sentence. Its audio is fetched straight away, while earlier sentences play. */
export function enqueueSpeech(sentence: string) {
  const text = speakable(sentence);
  if (!text) return;
  useSpeech.setState({ speaking: true });
  queue.push({ text, audio: fetchAudio(text) });
  void pump();
}

/** Say something, replacing whatever was being said. */
export function speak(text: string) {
  stopSpeaking();
  for (const sentence of splitSentences(speakable(text))) enqueueSpeech(sentence);
}

/** Stop at once (a short fade, so there is no click). Returns when the sound has ended, in performance.now() time. */
export function stopSpeaking(): number {
  generation++;
  queue = [];
  const playing = current;
  current = null;
  const ctx = audioContext();
  if (playing && ctx) {
    playing.gain.gain.cancelScheduledValues(ctx.currentTime);
    playing.gain.gain.setValueAtTime(playing.gain.gain.value, ctx.currentTime);
    playing.gain.gain.linearRampToValueAtTime(0, ctx.currentTime + FADE_SECONDS);
    try {
      playing.source.stop(ctx.currentTime + FADE_SECONDS + 0.01);
    } catch { /* already stopped */ }
  }
  useSpeech.setState({ speaking: false, audible: false });
  return performance.now() + (playing ? FADE_SECONDS * 1000 : 0);
}

/** Milliseconds since the current stretch of speaking began; 0 when silent. */
export function playbackAge(): number {
  return useSpeech.getState().audible ? performance.now() - playbackStartedAt : 0;
}

// When Scribe last stopped being heard. Anything said after that cannot be its echo.
let wentQuietAt = 0;
useSpeech.subscribe((now, before) => {
  if (before.audible && !now.audible) wentQuietAt = performance.now();
});

/** The moment Scribe's voice last stopped; Infinity while it is still speaking. */
export function quietSince(): number {
  return useSpeech.getState().audible ? Infinity : wentQuietAt;
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(Boolean);

/**
 * Is this transcript Scribe's own voice coming back through the microphone?
 * True when most of its words appear, in order and close together, in what
 * Scribe said in the last little while (or is saying now). An echo is one
 * stretch of Scribe's speech; a short question that merely shares scattered
 * words with a long answer is the writer.
 */
export function isOwnVoice(transcript: string): boolean {
  const words = norm(transcript);
  if (words.length < 3) return false;
  const now = Date.now();
  while (spoken.length && now - spoken[0].at > REMEMBER_MS) spoken.shift();
  const said = norm([...spoken.map((s) => s.text), ...queue.map((q) => q.text)].join(' '));
  if (said.length === 0) return false;
  // Slide a window a little longer than the transcript along what was said.
  const span = Math.ceil(words.length * 1.5);
  const need = words.length * 0.7;
  for (let start = 0; start < Math.max(1, said.length - span + 1); start++) {
    const stretch = said.slice(start, start + span);
    // Longest common subsequence of the transcript and this stretch.
    const row = new Array<number>(stretch.length + 1).fill(0);
    for (const w of words) {
      let diagonal = 0;
      for (let j = 1; j <= stretch.length; j++) {
        const up = row[j];
        row[j] = w === stretch[j - 1] ? diagonal + 1 : Math.max(row[j], row[j - 1]);
        diagonal = up;
      }
    }
    if (row[stretch.length] >= need) return true;
  }
  return false;
}

/** For tests: note a sentence as spoken without playing it. */
export function rememberSpoken(text: string) {
  spoken.push({ text: speakable(text), at: Date.now() });
}
