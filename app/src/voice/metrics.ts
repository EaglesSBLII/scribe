/**
 * Timings of the voice pipeline, kept so the speed targets can be measured
 * rather than assumed: how long from the end of a question to the first sound
 * of the answer, and how fast speaking stops when the writer talks over it.
 * All times are from performance.now(), in milliseconds.
 */

export interface Turn {
  /** The last moment the writer was speaking. */
  speechEnd: number;
  transcribed?: number;
  firstToken?: number;
  firstSentence?: number;
  audioStart?: number;
}

export interface BargeIn {
  /** When the writer's voice was first heard over Scribe's. */
  onset: number;
  /** When Scribe's voice had stopped. */
  stopped: number;
}

/** One dictated utterance: when the writer stopped speaking, and when its text was in the essay. */
export interface Dictated {
  speechEnd: number;
  written: number;
}

export const voiceMetrics: { turns: Turn[]; bargeIns: BargeIn[]; dictated: Dictated[]; current: Turn | null } = { turns: [], bargeIns: [], dictated: [], current: null };

export function recordDictated(speechEnd: number) {
  voiceMetrics.dictated.push({ speechEnd, written: performance.now() });
  if (voiceMetrics.dictated.length > 500) voiceMetrics.dictated.shift();
}

export function beginTurn(speechEnd: number) {
  voiceMetrics.current = { speechEnd };
  voiceMetrics.turns.push(voiceMetrics.current);
  if (voiceMetrics.turns.length > 200) voiceMetrics.turns.shift();
}

export function mark(stage: 'transcribed' | 'firstToken' | 'firstSentence' | 'audioStart') {
  const turn = voiceMetrics.current;
  if (turn && turn[stage] === undefined) turn[stage] = performance.now();
}

export function recordBargeIn(onset: number, stopped: number) {
  voiceMetrics.bargeIns.push({ onset, stopped });
}

if (typeof window !== 'undefined') (window as unknown as { __scribeVoice: typeof voiceMetrics }).__scribeVoice = voiceMetrics;
