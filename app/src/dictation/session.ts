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
import { looksLikeNoise, makeHighPass } from './frontend';
import { clean, type HeardWord } from './clean';
import { macUnreachable, platform, Unreachable, type Transcript } from '../platform';
import { hasQueuedAudio, queueAudio } from '../sync/queue';
import { useStore } from '../store';
import { useSettings } from '../settings';
import { isOwnVoice, playbackAge, quietSince, speak, stopSpeaking, useSpeech } from '../speech';
import { beginTurn, mark, recordBargeIn, recordDictated } from '../voice/metrics';
import { mayChangeEssay as changesEssay, parseCommand } from '../commands/parse';
import { isSleepRequest, readWake } from '../voice/wake';
import { playEarcon, unlockAudio } from '../voice/earcons';
import { askCounselor, interrupt, setVoiceOn } from '../voice/bus';
import { turnPause } from '../voice/turn';

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
  /** What has been said to the counselor so far in this turn, while Scribe waits for the rest. */
  turn: string;
}

export const useDictation = create<DictationState>(() => ({
  on: false, standby: false, awaiting: false, hearing: false, waiting: 0, interim: '', error: null, target: 'essay', turn: '',
}));

// Other parts of the app speak questions aloud only while the writer is working by voice.
useDictation.subscribe((s) => setVoiceOn(s.on && s.target === 'essay'));

export { setQuestionHandler } from '../voice/bus';

const MIN_SPEECH_SECONDS = 0.35;
/** How long after Scribe stops speaking its echo can still begin (speaker and room delay). */
const ECHO_TAIL_MS = 300;
/** A shorter pause ends an utterance while waiting for the wake word, so it answers quickly. */
const STANDBY_SILENCE = 0.5;
const DICTATION_SILENCE = 0.8;
const DICTATION_EARLY = 0.3;
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
let early: { length: number; exact: boolean; result: Promise<Heard | null> } | null = null;
let earlyBusy = false;
/** A newer pause arrived while an early transcription was still running: do it next. */
let earlyNext: Float32Array | null = null;

function startEarly(samples: Float32Array) {
  if (earlyBusy) {
    earlyNext = samples;
    return;
  }
  earlyBusy = true;
  earlyNext = null;
  let done!: (heard: Heard | null) => void;
  const result = new Promise<Heard | null>((resolve) => { done = resolve; });
  early = { length: samples.length, exact: true, result };
  void platform.transcribe(encodeWav(samples)).catch(() => null).then((heard) => {
    earlyBusy = false;
    done(heard);
    const next = earlyNext;
    // Only worth doing if that stretch of speech is still open; once it has closed, the
    // closing transcription has already been started.
    if (next && (!early || early.length < next.length)) startEarly(next);
    else earlyNext = null;
  });
}
/** The writer's usual speaking level, as learned in this microphone session. */
let knownVoice = 0;

type Heard = Transcript;

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

// ---- A whole turn for the counselor ----
// What is said to the counselor arrives in pieces, one per pause for breath. The
// pieces are held here and sent as one turn once the writer has really stopped.
let turn: string[] = [];
let turnSpeechEnd = 0;
let turnTimer: ReturnType<typeof setTimeout> | undefined;
/** The counselor was stopped because the writer kept talking; it still owes an answer. */
let answerOwed = false;

/** Speech goes to the counselor a turn at a time (conversation mode, or the counselor's own microphone). */
function talkingToCounselor(): boolean {
  const state = useDictation.getState();
  return state.on && !state.awaiting && !useStore.getState().pending
    && (state.target === 'counselor' || useSettings.getState().counselorMode === 'conversation');
}

function addToTurn(text: string, speechEnd: number) {
  turn.push(text);
  turnSpeechEnd = speechEnd;
  useDictation.setState({ turn: turn.join(' ') });
}

/** Start (or restart) the wait for the end of the turn. Nothing is sent while speech is still being heard or worked out. */
function armTurn() {
  clearTimeout(turnTimer);
  const state = useDictation.getState();
  if (state.hearing || state.waiting > 0) return;
  if (turn.length === 0) {
    // The writer made a sound but said nothing new: the counselor answers what it already has.
    if (answerOwed) {
      answerOwed = false;
      askCounselor('');
    }
    return;
  }
  const wait = turnSpeechEnd + turnPause(turn.join(' ')) - performance.now();
  turnTimer = setTimeout(sendTurn, Math.max(0, wait));
}

function sendTurn() {
  clearTimeout(turnTimer);
  const state = useDictation.getState();
  if (state.hearing || state.waiting > 0) return;
  const said = takeTurn();
  if (!said) return;
  // The counselor's own microphone is for one turn; it closes once the turn is over.
  if (state.on && state.target === 'counselor') stopDictation();
  askCounselor(said);
}

function takeTurn(): string {
  clearTimeout(turnTimer);
  const said = turn.join(' ');
  turn = [];
  answerOwed = false;
  if (useDictation.getState().turn) useDictation.setState({ turn: '' });
  return said;
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

async function heardWhileDictating(words: HeardWord[], paused: boolean, speechEnd: number) {
  // If Scribe has asked something ("this one?", "yes, delete it?"), this may be the answer.
  if (useStore.getState().answerPending(words)) return;
  if (useDictation.getState().awaiting) return addressed(words);
  const wake = readWake(words);
  if (!wake.wake && useSettings.getState().counselorMode === 'conversation') {
    // Conversation mode: what is said goes to the counselor, not into the essay.
    // Plain commands ("word count", "undo") still work without the name.
    const cmd = parseCommand(words, { addressed: true });
    if (cmd) return void useStore.getState().handleCommand(cmd);
    // It is held until the writer has finished the whole thought.
    const said = clean(words).text.replace(/\s+/g, ' ').trim();
    if (said) addToTurn(said, speechEnd);
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
    const offline = platform.kind === 'web' && macUnreachable();
    if (!offline) {
      fail('The speech engine is not running. Start Scribe with ./setup.sh or npm start.');
      return false;
    }
  }
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      // voiceIsolation asks the system for its strongest "this speaker only" processing where it
      // exists (it is ignored elsewhere); the other three are the browser's own clean-up.
      audio: { channelCount: 1, noiseSuppression: true, autoGainControl: true, echoCancellation: true, voiceIsolation: true } as MediaTrackConstraints,
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

  const rumbleOut = makeHighPass();
  chunker = new Chunker({
    startVoice: knownVoice,
    interimEvery: 1,
    onSpeechStart: () => {
      useDictation.setState({ hearing: true });
      // Still talking: the turn is not over.
      clearTimeout(turnTimer);
      chunker?.setEndSilence(endSilenceNow());
      // Something said to Scribe is short, so its quick transcription starts at the first
      // hint of a pause. Dictation is heard exactly, which takes longer, so it waits for a
      // pause that is likely to be the end of the sentence rather than a breath.
      chunker?.setEarlyQuiet(saidToScribe() ? 0.12 : DICTATION_EARLY);
    },
    earlyQuiet: 0.12,
    // Start transcribing at the first short pause; if the speaker stops there, the answer is already on its way.
    onEarly: (samples) => {
      if (samples.length < MIN_SPEECH_SECONDS * SAMPLE_RATE) return;
      if (saidToScribe()) {
        early = { length: samples.length, exact: false, result: platform.transcribe(encodeWav(samples), true).catch(() => null) };
        return;
      }
      // Dictating: hear it exactly straight away, so if the speaker has stopped here the
      // finished text is ready the moment the pause is long enough. One at a time.
      startEarly(samples);
    },
    onInterim: (samples) => {
      // A second of speech while the counselor is still thinking means the writer had not
      // finished. It stops, and answers once it has heard the rest.
      if (talkingToCounselor() && !useSpeech.getState().audible) {
        stopSpeaking();
        interrupt();
        answerOwed = true;
      }
      // Rough text is shown only while dictating; skip a preview if the last one is still being worked out.
      if (interimBusy || earlyBusy || !useDictation.getState().on) return;
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
      knownVoice = chunker?.voiceLevel ?? knownVoice;
      useDictation.setState({ hearing: false });
      const speculative = early;
      early = null;
      // Anything still queued for early transcription belonged to this stretch.
      earlyNext = null;
      if (samples.length < MIN_SPEECH_SECONDS * SAMPLE_RATE) {
        useDictation.setState({ interim: '' });
        return armTurn();
      }
      useDictation.setState((s) => ({ waiting: s.waiting + 1 }));
      const speechEnd = performance.now() - quietSeconds * 1000;
      const speechStart = performance.now() - (samples.length / SAMPLE_RATE) * 1000;
      // The early transcription covers this utterance if nothing but silence was added since.
      // It must reach to where the closing silence began: one from an earlier pause would
      // miss whatever was said after it.
      const speechLength = samples.length - Math.round(quietSeconds * SAMPLE_RATE);
      const reuse = paused && speculative && speculative.length >= speechLength && samples.length >= speculative.length;
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
          const rough = reuse ? await speculative.result : null;
          const heard = rough && speculative?.exact ? rough : await hear(wav, rough);
          // Wind, traffic or a bump that Whisper "heard" words in is not the writer.
          if (looksLikeNoise(heard, samples)) return;
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
            if (question) addToTurn(question, speechEnd);
          } else {
            await heardWhileDictating(heard.words, paused, speechEnd);
            recordDictated(speechEnd);
          }
        } catch (err) {
          if (err instanceof Unreachable && keepable()) await keep().catch(() => {});
          else useDictation.setState({ error: err instanceof Error ? err.message : 'Transcription failed.' });
        } finally {
          useDictation.setState((s) => ({ waiting: Math.max(0, s.waiting - 1), interim: s.hearing ? s.interim : '' }));
          armTurn();
        }
      });
    },
  });

  const source = ctx.createMediaStreamSource(stream);
  const node = new AudioWorkletNode(ctx, 'mic-capture');
  node.port.onmessage = (e: MessageEvent<Float32Array>) => {
    const resampled = toWhisperRate(e.data);
    if (!resampled.length) return;
    // Take out the low rumble of wind and traffic before anything listens to it.
    const data = rumbleOut(resampled);
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
  // A new session may be a different microphone, at a different level.
  knownVoice = 0;
  chunker?.flush();
  chunker = null;
  stream?.getTracks().forEach((t) => t.stop());
  stream = null;
  void ctx?.close();
  ctx = null;
  setAwaiting(false);
  takeTurn();
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
  // A conversation with the counselor lasts until the microphone is switched off.
  if (useSettings.getState().counselorMode === 'conversation') void useSettings.getState().set('counselorMode', 'draft');
  // Switching the microphone off ends the turn: what was said so far is sent.
  const said = takeTurn();
  if (said) askCounselor(said);
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
  const on = useDictation.getState().on;
  // Dictate only ever dictates. If a conversation with the counselor is going on, it ends
  // here and the microphone stays open for the essay.
  if (target === 'essay' && useSettings.getState().counselorMode === 'conversation') {
    void useSettings.getState().set('counselorMode', 'draft');
    if (on) {
      const said = takeTurn();
      if (said) askCounselor(said);
      return;
    }
  }
  if (on) stopDictation();
  else void startDictation(target);
}

/** The Jarvis button: talk with the counselor until it is pressed again. Nothing said goes into the essay. */
export async function toggleConversation() {
  const settings = useSettings.getState();
  if (useDictation.getState().on && settings.counselorMode === 'conversation') return stopDictation();
  await settings.set('counselorMode', 'conversation');
  if (!useDictation.getState().on) await startDictation('essay');
}

/** Switch the wake word on or off; the choice is remembered. */
export async function setWakeWord(enabled: boolean) {
  await useSettings.getState().set('wakeWord', enabled);
  const state = useDictation.getState();
  if (enabled && !state.on) await startStandby();
  if (!enabled && state.standby) closeMic();
}
