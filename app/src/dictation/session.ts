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
import { clean, type HeardWord } from './clean';
import { platform } from '../platform';
import { useStore } from '../store';
import { useSettings } from '../settings';
import { speak, useSpeech } from '../speech';
import { isSleepRequest, readWake } from '../voice/wake';
import { playEarcon, unlockAudio } from '../voice/earcons';
import { askCounselor, setVoiceOn } from '../voice/bus';

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
/** A shorter pause ends an utterance while waiting for the wake word, so it answers quickly. */
const STANDBY_SILENCE = 0.5;
const DICTATION_SILENCE = 0.9;
/** How long "Jarvis" on its own waits for the request that follows. */
const AWAIT_MS = 8000;

let ctx: AudioContext | null = null;
let stream: MediaStream | null = null;
let chunker: Chunker | null = null;
let chain: Promise<void> = Promise.resolve();
let interimBusy = false;
let chunkNo = 0;
let awaitTimer: ReturnType<typeof setTimeout> | undefined;

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
    fail('The speech engine is not running. Start Scribe with ./setup.sh or npm start.');
    return false;
  }
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, noiseSuppression: true, autoGainControl: true, echoCancellation: true },
    });
  } catch {
    fail('Scribe needs permission to use the microphone.');
    return false;
  }
  ctx = new AudioContext({ sampleRate: SAMPLE_RATE });
  if (ctx.sampleRate !== SAMPLE_RATE) {
    fail('This browser cannot record at the rate Whisper needs.');
    return false;
  }
  if (ctx.state === 'suspended') void ctx.resume();
  await ctx.audioWorklet.addModule(new URL('mic-worklet.js', document.baseURI).href);

  chunker = new Chunker({
    onSpeechStart: () => useDictation.setState({ hearing: true }),
    onInterim: (samples) => {
      // Rough text is shown only while dictating; skip a preview if the last one is still being worked out.
      if (interimBusy || !useDictation.getState().on) return;
      interimBusy = true;
      const mine = chunkNo;
      platform.transcribe(encodeWav(samples))
        .then((t) => {
          if (mine === chunkNo && useDictation.getState().hearing) {
            useDictation.setState({ interim: t.text.replace(/\s+/g, ' ').trim() });
          }
        })
        .catch(() => {})
        .finally(() => { interimBusy = false; });
    },
    onChunk: (samples, paused) => {
      chunkNo++;
      useDictation.setState({ hearing: false });
      if (samples.length < MIN_SPEECH_SECONDS * SAMPLE_RATE) return useDictation.setState({ interim: '' });
      useDictation.setState((s) => ({ waiting: s.waiting + 1 }));
      const wav = encodeWav(samples);
      // Chunks are transcribed one at a time so the text arrives in the order it was said.
      chain = chain.then(async () => {
        try {
          const heard = await platform.transcribe(wav);
          const state = useDictation.getState();
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
          useDictation.setState({ error: err instanceof Error ? err.message : 'Transcription failed.' });
        } finally {
          useDictation.setState((s) => ({ waiting: Math.max(0, s.waiting - 1), interim: s.hearing ? s.interim : '' }));
        }
      });
    },
  });

  const source = ctx.createMediaStreamSource(stream);
  const node = new AudioWorkletNode(ctx, 'mic-capture');
  node.port.onmessage = (e: MessageEvent<Float32Array>) => {
    // While Scribe is reading aloud, do not transcribe its own voice.
    if (!useSpeech.getState().speaking) chunker?.feed(e.data);
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
