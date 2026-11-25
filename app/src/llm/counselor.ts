/**
 * The counselor conversation. It reads the essay it is given and writes only
 * to the chat and story tables. It has no way to change an essay.
 */
import { create } from 'zustand';
import { db, type ChatRow, type Stage, type StoryRow } from '../db/schema';
import { platform, type ChatMessage } from '../platform';
import { useSettings } from '../settings';
import { docText } from '../doc/types';
import {
  BRAINSTORM_RULES, CANNED_DECLINE, COUNSELOR_RULES, essayContext, REPEAT_REMINDER, RETRY_REMINDER, SPOKEN_RULES, WRITE_REQUEST_REMINDER,
  type EssayView,
} from './prompts';
import { asksForWriting, isVerbatim, looksDrafted, repeatsItself } from './guard';
import { enqueueSpeech, speak, speechUnits, stopSpeaking, useSpeech } from '../speech';
import { playEarcon } from '../voice/earcons';
import { mark } from '../voice/metrics';

export type NudgeReason = 'paragraph' | 'pause' | 'limit';

const NUDGES: Record<NudgeReason, string> = {
  paragraph:
    '(The student has just finished a paragraph and paused. In one or two short sentences, react to that last paragraph: quote a few of their words and say one specific thing, or ask one question that would help the next paragraph. If nothing is worth saying, say only: Keep going.)',
  pause:
    '(The student has stopped talking for a while, mid-draft. In one short sentence, ask one specific question about what they just wrote that could help them continue. Do not suggest wording.)',
  limit:
    '(The student is close to, or over, the word limit for this prompt. In one or two short sentences, tell them where they stand and name one specific line or paragraph of theirs that could be cut or tightened, quoting a few of its words.)',
};

// How much of the conversation the model is shown: between 12 and 24 messages.
// The window moves forward a block at a time, not one message per turn. A
// window that slid every turn changed the start of the prompt every turn, so
// the model had to re-read all of it and each spoken answer started later.
const HISTORY_MAX = 24;
const HISTORY_STEP = 12;

export function recentHistory<T>(messages: T[]): T[] {
  const over = messages.length - HISTORY_MAX;
  return over <= 0 ? messages : messages.slice(Math.ceil(over / HISTORY_STEP) * HISTORY_STEP);
}

interface CounselorState {
  open: boolean;
  essayId: string | null;
  messages: ChatRow[];
  stories: StoryRow[];
  /** The reply being written right now. */
  streaming: string | null;
  busy: boolean;
  error: string | null;

  setOpen(open: boolean): void;
  load(essayId: string): Promise<void>;
  /** `spoken` means the answer is also said aloud, sentence by sentence. */
  ask(question: string, essay: EssayView & { id: string; accountId: string }, opts?: { spoken?: boolean }): Promise<void>;
  /** Answer, aloud, the last thing the student said, if it was never answered. */
  resume(essay: EssayView & { id: string; accountId: string }): Promise<void>;
  startBrainstorm(essay: EssayView & { id: string; accountId: string }, opts?: { spoken?: boolean }): Promise<void>;
  /** Get the model ready before the first spoken question. */
  warmUp(essay: EssayView): Promise<void>;
  /** Coach mode: speak up briefly at a natural break. */
  nudge(essay: EssayView & { id: string; accountId: string }, reason: NudgeReason): Promise<void>;
  mapStories(essay: EssayView & { id: string; accountId: string }): Promise<void>;
  stop(): void;
  clearChat(essayId: string): Promise<void>;
}

let abort: AbortController | null = null;
/** When the reply being written was first heard aloud (0: not yet). */
let heardAt = 0;
useSpeech.subscribe((s) => {
  if (s.audible && !heardAt) heardAt = performance.now();
});
/** A reply talked over this soon was not really heard: the student was still mid-thought. */
const BARELY_HEARD_MS = 2500;
/** An unanswered turn is still open for this long; after that, what is said next is a new turn. */
const TURN_OPEN_MS = 120_000;
const stillOpen = (last: ChatRow | undefined): last is ChatRow =>
  last?.role === 'user' && last.id !== undefined && Date.now() - last.ts < TURN_OPEN_MS;

export const useCounselor = create<CounselorState>((set, get) => {
  /** `earlier` is the conversation before this turn. */
  async function reply(essay: EssayView & { id: string }, earlier: ChatRow[], turn: ChatMessage, extraRules: string[], spoken: boolean, signal: AbortSignal) {
    const model = useSettings.getState().llmModel;
    const history = recentHistory(earlier).map((m): ChatMessage => ({ role: m.role, content: m.text }));
    const alreadySaid = earlier.filter((m) => m.role === 'assistant').slice(-6).map((m) => m.text);
    const system: ChatMessage[] = [
      { role: 'system', content: [COUNSELOR_RULES, ...extraRules].join('\n\n') },
      { role: 'system', content: essayContext(essay) },
    ];
    // Everything the student has written or said: quoting any of it is fine.
    const studentText = [docText(essay.doc), ...get().messages.filter((m) => m.role === 'user').map((m) => m.text), turn.content].join('\n');

    // When speaking, each finished sentence is voiced while the next is still being
    // written. A sentence is only voiced if the reply so far still passes the
    // "no drafted essay text" check.
    let voiced = 0;
    let silenced = false;
    const voice = (full: string, done: boolean) => {
      if (!spoken || silenced) return;
      const sentences = speechUnits(full);
      const ready = done ? sentences.length : Math.max(0, sentences.length - 1);
      for (; voiced < ready; voiced++) {
        const soFar = sentences.slice(0, voiced + 1).join(' ');
        if (looksDrafted(soFar, studentText).drafted || repeatsItself(soFar, alreadySaid)) {
          silenced = true;
          stopSpeaking();
          return;
        }
        if (voiced === 0) {
          playEarcon('counselor');
          mark('firstSentence');
        }
        enqueueSpeech(sentences[voiced]);
      }
    };
    const run = (messages: ChatMessage[], speakIt: boolean) => {
      signal.throwIfAborted();
      set({ streaming: '' });
      let full = '';
      return platform.llmChat(
        { model, messages, options: { temperature: 0.5 } },
        (delta) => {
          mark('firstToken');
          full += delta;
          set({ streaming: full });
          if (speakIt) voice(full, false);
        },
        signal,
      );
    };

    const base = [...system, ...history, turn];
    let text = (await run(base, true)).trim();
    if (looksDrafted(text, studentText).drafted) {
      // One more try with a reminder; if it drafts again, the student gets a plain refusal instead.
      silenced = true;
      if (spoken) stopSpeaking();
      const again = (await run([...base, { role: 'assistant', content: text }, { role: 'system', content: RETRY_REMINDER }, turn], false)).trim();
      text = looksDrafted(again, studentText).drafted ? CANNED_DECLINE : again;
      if (spoken) speak(text);
    } else if (repeatsItself(text, alreadySaid)) {
      // It said this before. One more try, told to respond to what was just said instead.
      silenced = true;
      if (spoken) stopSpeaking();
      const again = (await run([...base, { role: 'assistant', content: text }, { role: 'system', content: REPEAT_REMINDER }, turn], false)).trim();
      text = looksDrafted(again, studentText).drafted ? CANNED_DECLINE : again || text;
      if (spoken) speak(text);
    } else {
      voice(text, true);
    }
    return text;
  }

  /**
   * One turn. `shown` is what the student said (null when Scribe speaks unasked).
   * With `continues`, a turn that was never answered is carried on rather than
   * followed by a second one: the student had not finished.
   */
  async function exchange(essay: EssayView & { id: string }, shown: string | null, turn: ChatMessage, extraRules: string[], spoken = false, continues = false) {
    if (get().busy) return;
    set({ busy: true, error: null });
    // Made before anything is awaited, so a stop that arrives early is not missed.
    const mine = new AbortController();
    abort = mine;
    heardAt = 0;
    const speakIt = spoken && useSettings.getState().speakReplies;
    const stage = essay.stage as Stage;
    const save = async (text: string) => {
      const row: ChatRow = { essayId: essay.id, ts: Date.now(), role: 'assistant', text, stage };
      row.id = await db.chats.add(row);
      if (get().essayId === essay.id) set((s) => ({ messages: [...s.messages, row] }));
    };
    try {
      let earlier = get().messages;
      if (shown !== null) {
        const last = earlier.at(-1);
        const unanswered = continues && stillOpen(last) ? last : null;
        const text = unanswered ? `${unanswered.text} ${shown}`.trim() : shown;
        if (unanswered) {
          earlier = earlier.slice(0, -1);
          await db.chats.delete(unanswered.id!);
        }
        const said: ChatRow = { essayId: essay.id, ts: Date.now(), role: 'user', text, stage };
        said.id = await db.chats.add(said);
        set({ messages: [...earlier, said] });
        turn = { role: 'user', content: text };
      }
      await save(await reply(essay, earlier, turn, speakIt ? [...extraRules, SPOKEN_RULES] : extraRules, speakIt, mine.signal));
    } catch (err) {
      const stopped = mine.signal.aborted || (err instanceof Error && err.name === 'AbortError');
      // Cut off by the writer after some of it was heard: keep that much, marked as unfinished, so the
      // conversation still makes sense. Cut off before it had really been heard (the writer was still
      // talking): nothing is kept, and the turn stays open for the rest of what they say.
      const partial = (get().streaming ?? '').trim();
      const heard = heardAt > 0 && performance.now() - heardAt > BARELY_HEARD_MS;
      if (stopped && partial && (heard || !speakIt)) await save(`${partial} [interrupted]`);
      if (!stopped) set({ error: err instanceof Error ? err.message : 'The counselor could not answer.' });
    } finally {
      if (abort === mine) abort = null;
      set({ busy: false, streaming: null });
    }
  }

  const rulesFor = (text: string, essay: EssayView) => {
    const rules = essay.stage === 'brainstorm' ? [BRAINSTORM_RULES] : [];
    if (asksForWriting(text)) rules.push(WRITE_REQUEST_REMINDER);
    return rules;
  };

  return {
    open: false,
    essayId: null,
    messages: [],
    stories: [],
    streaming: null,
    busy: false,
    error: null,

    setOpen: (open) => set({ open }),

    async load(essayId) {
      get().stop();
      const [messages, stories] = await Promise.all([
        db.chats.where('essayId').equals(essayId).sortBy('ts'),
        db.stories.filter((s) => s.essayId === essayId).toArray(),
      ]);
      set({ essayId, messages, stories: stories.sort((a, b) => b.fit - a.fit), error: null, streaming: null });
    },

    async ask(question, essay, opts = {}) {
      const text = question.trim();
      if (!text) return;
      await exchange(essay, text, { role: 'user', content: text }, rulesFor(text, essay), opts.spoken, opts.spoken);
    },

    async resume(essay) {
      const last = get().messages.at(-1);
      if (get().busy || !stillOpen(last)) return;
      await exchange(essay, '', { role: 'user', content: last.text }, rulesFor(last.text, essay), true, true);
    },

    async startBrainstorm(essay, opts = {}) {
      await exchange(essay, null, { role: 'user', content: 'Please start the brainstorm with your first question.' }, [BRAINSTORM_RULES], opts.spoken);
    },

    async warmUp(essay) {
      // Load the model and let it read the rules and the essay once, so the first real answer starts quickly.
      if (get().busy) return;
      try {
        await platform.llmChat({
          model: useSettings.getState().llmModel,
          options: { temperature: 0.5, num_predict: 1 },
          messages: [
            { role: 'system', content: [COUNSELOR_RULES, SPOKEN_RULES].join('\n\n') },
            { role: 'system', content: essayContext(essay) },
            { role: 'user', content: 'Hi.' },
          ],
        });
      } catch { /* not running; the first question will say so */ }
    },

    async nudge(essay, reason) {
      // Coach mode: a brief remark at a natural break. Nothing is added to the conversation on the student's side.
      await exchange(essay, null, { role: 'user', content: NUDGES[reason] }, [], true);
    },

    async mapStories(essay) {
      if (get().busy) return;
      const said = get().messages.filter((m) => m.role === 'user').map((m) => m.text);
      if (said.join(' ').trim().length < 40) {
        return set({ error: 'Answer a few brainstorm questions first, so there are stories to map.' });
      }
      set({ busy: true, error: null });
      try {
        const raw = await platform.llmChat({
          model: useSettings.getState().llmModel,
          options: { temperature: 0, seed: 7 },
          format: {
            type: 'object',
            required: ['stories'],
            properties: {
              stories: {
                type: 'array',
                items: {
                  type: 'object',
                  required: ['title', 'quote', 'fit', 'reason'],
                  properties: {
                    title: { type: 'string' },
                    quote: { type: 'string' },
                    fit: { type: 'integer', minimum: 1, maximum: 5 },
                    reason: { type: 'string' },
                  },
                },
              },
            },
          },
          messages: [
            {
              role: 'system',
              content:
                'You sort a student\'s brainstorm into the separate stories they told. For each story give: "title" (at most six words), "quote" (a phrase of at most 25 words copied EXACTLY, word for word, from what the student said), "fit" (1 to 5: how well this story could answer the essay prompt; 5 is a strong fit), and "reason" (one sentence explaining the fit, addressed to the student). List only stories the student actually told. Do not invent or embellish anything. Answer in JSON.',
            },
            {
              role: 'user',
              content: `Essay prompt: ${essay.promptText.trim() || 'A personal statement that shows who the student is.'}\n\nWhat the student said while brainstorming:\n${said.map((t) => `- ${t}`).join('\n')}`,
            },
          ],
        });
        const parsed = JSON.parse(raw) as { stories?: { title?: unknown; quote?: unknown; fit?: unknown; reason?: unknown }[] };
        const all = said.join('\n');
        const stories: StoryRow[] = [];
        for (const s of parsed.stories ?? []) {
          if (typeof s.title !== 'string' || typeof s.quote !== 'string' || typeof s.reason !== 'string') continue;
          // A story must be anchored in the student's own words, or it is dropped.
          if (!isVerbatim(s.quote, all)) continue;
          const fit = Math.min(5, Math.max(1, Math.round(Number(s.fit) || 1)));
          stories.push({
            id: crypto.randomUUID(), accountId: essay.accountId, essayId: essay.id,
            title: s.title.trim(), quote: s.quote.trim(), fit, reason: s.reason.trim(), ts: Date.now(),
          });
        }
        await db.transaction('rw', db.stories, async () => {
          await db.stories.filter((s) => s.essayId === essay.id).delete();
          await db.stories.bulkAdd(stories);
        });
        set({
          stories: stories.sort((a, b) => b.fit - a.fit),
          error: stories.length ? null : 'No clear stories yet. Keep talking and try again.',
        });
      } catch (err) {
        set({ error: err instanceof Error ? err.message : 'Could not map the stories.' });
      } finally {
        set({ busy: false });
      }
    },

    stop() {
      abort?.abort();
      abort = null;
    },

    async clearChat(essayId) {
      await db.chats.where('essayId').equals(essayId).delete();
      if (get().essayId === essayId) set({ messages: [] });
    },
  };
});
