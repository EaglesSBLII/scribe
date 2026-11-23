/**
 * The microphone session.
 *
 *   off      microphone closed
 *   standby  microphone open, waiting for the wake word "Jarvis"; nothing else is kept
 *   on       dictating: speech becomes essay text, and an utterance that begins
 *            with "Jarvis" is a command or question instead
 *
 * Microphone -> speech chunks -> local Whisper -> the essay, a command, or the counselor.
 */
import { create } from 'zustand';
import { Chunker, encodeWav, SAMPLE_RATE } from './chunker';
import { makeResampler } from './resample';
import { clean, type HeardWord } from './clean';
import { platform, Unreachable } from '../platform';
import { hasQueuedAudio, queueAudio } from '../sync/queue';
import { useSync } from '../sync';
import { useStore } from '../store';
import { useSettings } from '../settings';
import { isOwnVoice, playbackAge, quietSince, speak, stopSpeaking, useSpeech } from '../speech';
import { beginTurn, mark, recordBargeIn } from '../voice/metrics';
import { parseCommand } from '../commands/parse';
import { isSleepRequest, readWake } from '../voice/wake';
import { playEarcon, unlockAudio } from '../voice/earcons';
import { askCounselor, interrupt, setVoiceOn } from '../voice/bus';

interface DictationState {
  /** Dictating. */
  on: boolean;
  /** Microphone open, waiting for "Jarvis". */
  standby: boolean;
  /** "Jarvis" was said on its own; the next thing said is a request. */
  awaiting: boolean;
  /** Speech is being heard right now. */
  hearing: boolean;
  /** Finished chunks still being transcribed. */
  waiting: number;
  /** Unpolished text for the speech in progress. */
  interim: string;
  error: string | null;
  /** Where the words go: into the essay, or to the counselor as a question. */
  target: 'essay' | 'counselor';
}

export const useDictation = create<DictationState>(() => ({
  on: false, standby: false, awaiting: false, hearing: false, waiting: 0, interim: '', error: null, target: 'essay',
}));

// Other parts of the app speak questions aloud only while the writer is working by voice.
useDictation.subscribe((s) => setVoiceOn(s.on && s.target === 'essay'));

export { setQuestionHandler } from '../voice/bus';

const MIN_SPEECH_SECONDS = 0.35;
/** How long after Scribe stops speaking its echo can still begin (speaker and room delay). */
const ECHO_TAIL_MS = 300;
/** A shorter pause ends an utterance while waiting for the wake word, so it answers quickly. */
const STANDBY_SILENCE = 0.5;
const DICTATION_SILENCE = 0.9;
/** In conversation, a shorter pause ends a turn, so the counselor answers sooner. */
const CONVERSATION_SILENCE = 0.6;
/** How long "Jarvis" on its own waits for the request that follows. */
const AWAIT_MS = 8000;

let ctx: AudioContext | null = null;
let stream: MediaStream | null = null;
let chunker: Chunker | null = null;
let chain: Promise<void> = Promise.resolve();
let interimBusy = false;
let chunkNo = 0;
let awaitTimer: ReturnType<typeof setTimeout> | undefined;

/** An early transcription, started at the first short pause in case the speaker has finished. */
let early: { length: number; result: Promise<{ text: string; words: HeardWord[] } | null> } | null = null; // always from the quick transcriber

type Heard = { text: string; words: HeardWord[] };

/** Requests that change the essay: these are always heard with the exact transcriber. */
const EDITS = /^(delete|remove|erase|scratch|cut|insert|add|put|move|replace|change|swap|shift|undo|redo)$/;
const changesEssay = (rest: HeardWord[]) => EDITS.test((rest[0]?.text ?? '').toLowerCase().replace(/[^a-z]/g, ''));

/** What is said right now is for Scribe (the wake word, an answer, the counselor), not for the essay. */
function saidToScribe(): boolean {
  const state = useDictation.getState();
  return state.standby || state.awaiting || state.target === 'counselor' || !!useStore.getState().pending
    || useSettings.getState().counselorMode === 'conversation';
}

/**
 * Turn an utterance into words. The quick transcriber is used only for things
 * said to Scribe; anything that becomes essay text or edits the essay is heard
 * by the exact one.
 */
async function hear(wav: ArrayBuffer, rough: Heard | null): Promise<Heard> {
  const fast = saidToScribe();
  const quick = rough ?? (fast ? await platform.transcribe(wav, true) : null);
  if (quick) {
    const wake = readWake(quick.words);
    if (useDictation.getState().standby) {
      // Not the wake word: it is thrown away anyway. A request that edits the essay is heard again, exactly.
      if (!wake.wake || !changesEssay(wake.rest)) return quick;
    } else if (fast) {
      if (!changesEssay(wake.wake ? wake.rest : quick.words)) return quick;
    } else if (wake.wake && !changesEssay(wake.rest)) {
      // Dictating, and this was a question or request to Scribe by name.
      return quick;
    }
  }
  return platform.transcribe(wav);
}

/** How long a pause ends an utterance right now. Conversation is quicker than dictation. */
function endSilenceNow(): number {
  const state = useDictation.getState();
  if (state.standby) return STANDBY_SILENCE;
  if (state.awaiting || useStore.getState().pending || useSettings.getState().counselorMode === 'conversation') return CONVERSATION_SILENCE;
  return DICTATION_SILENCE;
}

// ---- Talking over Scribe (barge-in) ----
// The browser's echo cancellation takes Scribe's own voice out of the
// microphone, but not perfectly at the start of a sentence. So an interruption
// needs the writer's voice to be clearly present for a short run of frames,
// and is not accepted in the first moments of playback.
const BARGE_FRAME = 480; // 30 ms at 16 kHz
const BARGE_FRAMES_NEEDED = 5; // 150 ms of clear voice
const BARGE_GUARD_MS = 350;
let bargeBuffer = new Float32Array(0);
let bargeRun = 0;
let bargeOnset = 0;
let roomNoise = 0.004;

function frames(data: Float32Array, each: (rms: number) => void) {
  const all = new Float32Array(bargeBuffer.length + data.length);
  all.set(bargeBuffer);
  all.set(data, bargeBuffer.length);
  let i = 0;
  for (; i + BARGE_FRAME <= all.length; i += BARGE_FRAME) {
    let sum = 0;
    for (let j = i; j < i + BARGE_FRAME; j++) sum += all[j] * all[j];
    each(Math.sqrt(sum / BARGE_FRAME));
  }
  bargeBuffer = all.slice(i);
}

function followRoomNoise(data: Float32Array) {
  bargeRun = 0;
  frames(data, (rms) => {
    if (rms < 0.02) roomNoise = roomNoise * 0.97 + rms * 0.03;
  });
}

function watchForBargeIn(data: Float32Array) {
  frames(data, (rms) => {
    const loud = rms > Math.max(0.03, roomNoise * 4);
    if (!loud) {
      bargeRun = 0;
      return;
    }
    if (bargeRun === 0) bargeOnset = performance.now() - 30;
    bargeRun++;
    if (bargeRun >= BARGE_FRAMES_NEEDED && playbackAge() > BARGE_GUARD_MS) {
      bargeRun = 0;
      const stopped = stopSpeaking();
      recordBargeIn(bargeOnset, stopped);
      // Whatever the counselor was still writing is dropped too.
      interrupt();
    }
  });
}

function fail(message: string) {
  closeMic();
  useDictation.setState({ error: message });
}

function setAwaiting(awaiting: boolean) {
  clearTimeout(awaitTimer);
  useDictation.setState({ awaiting });
  if (awaiting) awaitTimer = setTimeout(() => useDictation.setState({ awaiting: false }), AWAIT_MS);
}

/** "Jarvis" was heard while waiting: start a session. */
function wakeUp(rest: HeardWord[], alone: boolean) {
  playEarcon('wake');
  chunker?.setEndSilence(DICTATION_SILENCE);
  useDictation.setState({ on: true, standby: false, target: 'essay', interim: '' });
  if (alone || rest.length === 0) {
    speak("I'm listening.");
    return;
  }
  return addressed(rest);
}

/** Something said to Scribe by name: never essay text. */
async function addressed(words: HeardWord[]) {
  setAwaiting(false);
  if (isSleepRequest(words)) {
    stopDictation();
    return;
  }
  await useStore.getState().handleAddressed(words);
}

async function heardWhileDictating(words: HeardWord[], paused: boolean) {
  // If Scribe has asked something ("this one?", "yes, delete it?"), this may be the answer.
  if (useStore.getState().answerPending(words)) return;
  if (useDictation.getState().awaiting) return addressed(words);
  const wake = readWake(words);
  if (!wake.wake && useSettings.getState().counselorMode === 'conversation') {
    // Conversation mode: what is said goes to the counselor, not into the essay.
    // Plain commands ("word count", "undo") still work without the name.
    const cmd = parseCommand(words);
    if (cmd) return void useStore.getState().handleCommand(cmd);
    const said = clean(words).text.replace(/\s+/g, ' ').trim();
    if (said) askCounselor(said);
    return;
  }
  if (!wake.wake) return useStore.getState().insertHeard(words, paused);
  if (wake.alone) {
    // Just the name: acknowledge, and treat whatever comes next as the request.
    playEarcon('wake');
    setAwaiting(true);
    return;
  }
  return addressed(wake.rest);
}

async function openMic(): Promise<boolean> {
  if (stream) return true;
  unlockAudio();
  if (!(await platform.asrAvailable())) {
    // Out of reach of the Mac (a phone away from home): recording still works, and is transcribed later.
    const offline = platform.kind === 'web' && (!navigator.onLine || !useSync.getState().online);
    if (!offline) {
      fail('The speech engine is not running. Start Scribe with ./setup.sh or npm start.');
      return false;
    }
  }
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, noiseSuppression: true, autoGainControl: true, echoCancellation: true },
    });
  } catch {
    fail('Scribe needs permission to use the microphone.');
    return false;
  }
  // Record at Whisper's rate where the browser can; otherwise convert on the way in.
  try {
    ctx = new AudioContext({ sampleRate: SAMPLE_RATE });
  } catch {
    ctx = new AudioContext();
  }
  const toWhisperRate = makeResampler(ctx.sampleRate, SAMPLE_RATE);
  if (ctx.state === 'suspended') void ctx.resume();
  await ctx.audioWorklet.addModule(new URL('mic-worklet.js', document.baseURI).href);

  chunker = new Chunker({
    onSpeechStart: () => {
      useDictation.setState({ hearing: true });
      chunker?.setEndSilence(endSilenceNow());
    },
    earlyQuiet: 0.12,
    // Start transcribing at the first short pause; if the speaker stops there, the answer is already on its way.
    onEarly: (samples) => {
      if (samples.length < MIN_SPEECH_SECONDS * SAMPLE_RATE) return;
      early = { length: samples.length, result: platform.transcribe(encodeWav(samples), true).catch(() => null) };
    },
    onInterim: (samples) => {
      // Rough text is shown only while dictating; skip a preview if the last one is still being worked out.
      if (interimBusy || !useDictation.getState().on) return;
      interimBusy = true;
      const mine = chunkNo;
      platform.transcribe(encodeWav(samples), true)
        .then((t) => {
          if (mine === chunkNo && useDictation.getState().hearing) {
            useDictation.setState({ interim: t.text.replace(/\s+/g, ' ').trim() });
          }
        })
        .catch(() => {})
        .finally(() => { interimBusy = false; });
    },
    onChunk: (samples, paused, quietSeconds) => {
      chunkNo++;
      useDictation.setState({ hearing: false });
      const speculative = early;
      early = null;
      if (samples.length < MIN_SPEECH_SECONDS * SAMPLE_RATE) return useDictation.setState({ interim: '' });
      useDictation.setState((s) => ({ waiting: s.waiting + 1 }));
      const speechEnd = performance.now() - quietSeconds * 1000;
      const speechStart = performance.now() - (samples.length / SAMPLE_RATE) * 1000;
      // The early transcription covers this utterance if nothing but silence was added since.
      const reuse = paused && speculative && samples.length >= speculative.length && samples.length - speculative.length <= 1.2 * SAMPLE_RATE;
      const wav = encodeWav(samples);
      // Chunks are transcribed one at a time so the text arrives in the order it was said.
      chain = chain.then(async () => {
        // Plain dictation into the essay can be kept as audio when the Mac is out of reach.
        const keepable = () => useDictation.getState().on && useDictation.getState().target === 'essay' && !saidToScribe();
        const keep = async () => {
          if (await queueAudio(wav, paused)) useStore.getState().setToast({ text: 'Offline. Saved on this device; it will be transcribed when connected.' });
        };
        try {
          // Earlier recordings are still waiting: this one waits behind them, to keep the order.
          if (keepable() && hasQueuedAudio()) return await keep();
          const heard = await hear(wav, reuse ? await speculative.result : null);
          const state = useDictation.getState();
          // Scribe's own voice coming back through the microphone is never taken as the writer's.
          // Only speech that began while Scribe was talking (or just after) can be its echo:
          // "yes, delete it" said in answer to Scribe's question is the writer.
          if (speechStart < quietSince() + ECHO_TAIL_MS && isOwnVoice(heard.text)) return;
          beginTurn(speechEnd);
          mark('transcribed');
          if (state.standby) {
            // Waiting for the wake word: everything else that is said is ignored and not kept.
            const wake = readWake(heard.words);
            if (wake.wake) await wakeUp(wake.rest, wake.alone);
          } else if (!state.on) {
            // The microphone was switched off while this was being transcribed.
          } else if (state.target === 'counselor') {
            // A spoken question for the counselor: it goes to the panel, never the essay.
            const question = clean(heard.words).text.replace(/\s+/g, ' ').trim();
            stopDictation();
            if (question) askCounselor(question);
          } else {
            await heardWhileDictating(heard.words, paused);
          }
        } catch (err) {
          if (err instanceof Unreachable && keepable()) await keep().catch(() => {});
          else useDictation.setState({ error: err instanceof Error ? err.message : 'Transcription failed.' });
        } finally {
          useDictation.setState((s) => ({ waiting: Math.max(0, s.waiting - 1), interim: s.hearing ? s.interim : '' }));
        }
      });
    },
  });

  const source = ctx.createMediaStreamSource(stream);
  const node = new AudioWorkletNode(ctx, 'mic-capture');
  node.port.onmessage = (e: MessageEvent<Float32Array>) => {
    const data = toWhisperRate(e.data);
    if (!data.length) return;
    const speech = useSpeech.getState();
    if (speech.audible) {
      // With interrupting switched off, the microphone is simply ignored while Scribe speaks.
      if (!useSettings.getState().bargeIn) return;
      watchForBargeIn(data);
    } else {
      followRoomNoise(data);
    }
    chunker?.feed(data);
  };
  source.connect(node);
  return true;
}

function closeMic() {
  chunker?.flush();
  chunker = null;
  stream?.getTracks().forEach((t) => t.stop());
  stream = null;
  void ctx?.close();
  ctx = null;
  setAwaiting(false);
  useDictation.setState({ on: false, standby: false, hearing: false });
}

export async function startDictation(target: 'essay' | 'counselor' = 'essay') {
  if (useDictation.getState().on) return;
  useDictation.setState({ error: null, target });
  if (!(await openMic())) return;
  chunker?.setEndSilence(DICTATION_SILENCE);
  useDictation.setState({ on: true, standby: false });
  playEarcon('listenStart');
}

/** Open the microphone and wait for "Jarvis". Nothing said before the wake word is kept. */
export async function startStandby() {
  const state = useDictation.getState();
  if (state.on || state.standby) return;
  useDictation.setState({ error: null });
  if (!(await openMic())) return;
  chunker?.setEndSilence(STANDBY_SILENCE);
  useDictation.setState({ standby: true, on: false });
}

/** Stop dictating. With the wake word switched on, Scribe goes back to waiting for "Jarvis". */
export function stopDictation() {
  const wasOn = useDictation.getState().on;
  if (useSettings.getState().wakeWord && stream) {
    chunker?.flush();
    chunker?.setEndSilence(STANDBY_SILENCE);
    setAwaiting(false);
    useDictation.setState({ on: false, standby: true, hearing: false, interim: '' });
  } else {
    closeMic();
  }
  if (wasOn) playEarcon('listenStop');
}

export function toggleDictation(target: 'essay' | 'counselor' = 'essay') {
  if (useDictation.getState().on) stopDictation();
  else void startDictation(target);
}

/** Switch the wake word on or off; the choice is remembered. */
export async function setWakeWord(enabled: boolean) {
  await useSettings.getState().set('wakeWord', enabled);
  const state = useDictation.getState();
  if (enabled && !state.on) await startStandby();
  if (!enabled && state.standby) closeMic();
}
