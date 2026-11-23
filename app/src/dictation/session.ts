/** Live dictation: microphone -> speech chunks -> local Whisper -> cleaned text in the essay. */
import { create } from 'zustand';
import { Chunker, encodeWav, SAMPLE_RATE } from './chunker';
import { clean } from './clean';
import { platform } from '../platform';
import { useStore } from '../store';
import { useSpeech } from '../speech';

interface DictationState {
  on: boolean;
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
  on: false, hearing: false, waiting: 0, interim: '', error: null, target: 'essay',
}));

let onQuestion: ((text: string) => void) | null = null;

/** The counselor panel registers here to receive spoken questions. */
export function setQuestionHandler(handler: ((text: string) => void) | null) {
  onQuestion = handler;
}

const MIN_SPEECH_SECONDS = 0.35;

let ctx: AudioContext | null = null;
let stream: MediaStream | null = null;
let chunker: Chunker | null = null;
let chain: Promise<void> = Promise.resolve();
let interimBusy = false;
let chunkNo = 0;

function fail(message: string) {
  stopDictation();
  useDictation.setState({ error: message });
}

export async function startDictation(target: 'essay' | 'counselor' = 'essay') {
  if (useDictation.getState().on) return;
  useDictation.setState({ error: null, target });
  if (!(await platform.asrAvailable())) {
    return fail('The speech engine is not running. Start Scribe with ./setup.sh or npm start.');
  }
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, noiseSuppression: true, autoGainControl: true },
    });
  } catch {
    return fail('Scribe needs permission to use the microphone.');
  }
  ctx = new AudioContext({ sampleRate: SAMPLE_RATE });
  if (ctx.sampleRate !== SAMPLE_RATE) return fail('This browser cannot record at the rate Whisper needs.');
  await ctx.audioWorklet.addModule(new URL('mic-worklet.js', document.baseURI).href);

  chunker = new Chunker({
    onSpeechStart: () => useDictation.setState({ hearing: true }),
    onInterim: (samples) => {
      // Skip a preview if the last one is still being worked out.
      if (interimBusy) return;
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
          if (useDictation.getState().target === 'counselor') {
            // A spoken question for the counselor: it goes to the panel, never the essay.
            const question = clean(heard.words).text.replace(/\s+/g, ' ').trim();
            stopDictation();
            if (question) onQuestion?.(question);
          } else {
            await useStore.getState().insertHeard(heard.words, paused);
          }
        } catch (err) {
          useDictation.setState({ error: err instanceof Error ? err.message : 'Transcription failed.' });
        } finally {
          useDictation.setState((s) => ({ waiting: s.waiting - 1, interim: s.hearing ? s.interim : '' }));
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
  useDictation.setState({ on: true });
}

export function stopDictation() {
  chunker?.flush();
  chunker = null;
  stream?.getTracks().forEach((t) => t.stop());
  stream = null;
  void ctx?.close();
  ctx = null;
  useDictation.setState({ on: false, hearing: false });
}

export function toggleDictation(target: 'essay' | 'counselor' = 'essay') {
  if (useDictation.getState().on) stopDictation();
  else void startDictation(target);
}
