/**
 * Connects the voice session to the counselor, and runs coach mode.
 *
 *  - A question asked by voice is answered out loud.
 *  - Talking over the counselor also stops it writing.
 *  - In coach mode it speaks up briefly at natural breaks: when a paragraph
 *    ends, after a pause of about six seconds, or when the word limit is near.
 */
import { useStore } from '../store';
import { useSettings } from '../settings';
import { useCounselor, type NudgeReason } from '../llm/counselor';
import { useDictation } from '../dictation/session';
import { useSpeech } from '../speech';
import { paraText } from '../doc/types';
import { currentEssay, viewOf } from '../features/counselorView';
import { setInterruptHandler, setQuestionHandler } from './bus';

const PAUSE_MS = 6000;
const COOLDOWN_MS = 40_000;
const MIN_NEW_WORDS = 20;

let started = false;
let pauseTimer: ReturnType<typeof setTimeout> | undefined;
let lastNudgeAt = 0;
let wordsAtLastNudge = 0;
let watching: { essayId: string; paragraphs: number; words: number; limitStage: 0 | 1 | 2 } | null = null;

function nudge(reason: NudgeReason) {
  const essay = currentEssay();
  const counselor = useCounselor.getState();
  const dictation = useDictation.getState();
  if (!essay || useSettings.getState().counselorMode !== 'coach') return;
  // Never talk over the writer, itself, or an open question.
  if (!dictation.on || dictation.hearing || dictation.waiting > 0 || counselor.busy || useSpeech.getState().speaking || useStore.getState().pending) return;
  if (Date.now() - lastNudgeAt < COOLDOWN_MS) return;
  lastNudgeAt = Date.now();
  wordsAtLastNudge = essay.wordCount;
  void counselor.nudge(viewOf(essay), reason);
}

export function startCoach() {
  if (started) return;
  started = true;

  // What the writer has said that the counselor has not yet been given, and the wait for it to be free.
  let queued: string | null = null;
  let off: (() => void) | null = null;
  setQuestionHandler((text) => {
    const essay = currentEssay();
    if (!essay) return;
    const counselor = useCounselor.getState();
    counselor.setOpen(true);
    const go = () => {
      const said = queued;
      queued = null;
      const now = currentEssay();
      if (said === null || !now) return;
      // No new words means: answer what was said before the writer made a sound.
      if (said) void useCounselor.getState().ask(said, viewOf(now), { spoken: true });
      else void useCounselor.getState().resume(viewOf(now));
    };
    queued = [queued, text].filter(Boolean).join(' ');
    if (!counselor.busy) return go();
    // Still writing an answer: something new takes over instead of being lost.
    if (text) counselor.stop();
    off ??= useCounselor.subscribe((s) => {
      if (s.busy) return;
      off?.();
      off = null;
      go();
    });
  });
  setInterruptHandler(() => useCounselor.getState().stop());

  // When the microphone opens, get the counselor and the voice ready in the background.
  let wasListening = false;
  useDictation.subscribe((d) => {
    const listening = d.on || d.standby;
    if (listening && !wasListening) {
      const essay = currentEssay();
      if (essay && useSettings.getState().speakReplies) void useCounselor.getState().warmUp(viewOf(essay));
    }
    wasListening = listening;
  });

  useStore.subscribe((state) => {
    const essay = state.essays.find((e) => e.id === state.currentId);
    if (!essay) {
      watching = null;
      return;
    }
    const paragraphs = essay.doc.paragraphs.filter((p) => paraText(p).trim()).length;
    const limit = essay.wordLimit ?? 0;
    const limitStage: 0 | 1 | 2 = limit && essay.wordCount > limit ? 2 : limit && essay.wordCount >= limit * 0.9 ? 1 : 0;
    if (!watching || watching.essayId !== essay.id) {
      watching = { essayId: essay.id, paragraphs, words: essay.wordCount, limitStage };
      wordsAtLastNudge = essay.wordCount;
      return;
    }
    const before = watching;
    watching = { essayId: essay.id, paragraphs, words: essay.wordCount, limitStage };
    if (essay.wordCount === before.words) return;

    // The essay just changed. Decide whether this is a natural break.
    clearTimeout(pauseTimer);
    if (limitStage > before.limitStage) return nudge('limit');
    if (paragraphs > before.paragraphs && essay.wordCount - wordsAtLastNudge >= MIN_NEW_WORDS) return nudge('paragraph');
    pauseTimer = setTimeout(() => {
      const now = currentEssay();
      if (now && now.wordCount - wordsAtLastNudge >= MIN_NEW_WORDS) nudge('pause');
    }, PAUSE_MS);
  });
}
