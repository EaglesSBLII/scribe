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
  BRAINSTORM_RULES, CANNED_DECLINE, COUNSELOR_RULES, essayContext, RETRY_REMINDER, SPOKEN_RULES, WRITE_REQUEST_REMINDER,
  type EssayView,
} from './prompts';
import { asksForWriting, isVerbatim, looksDrafted } from './guard';
import { enqueueSpeech, speak, speechUnits, stopSpeaking } from '../speech';
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

const HISTORY_TURNS = 12;

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

export const useCounselor = create<CounselorState>((set, get) => {
  async function reply(essay: EssayView & { id: string }, turn: ChatMessage, extraRules: string[], spoken: boolean) {
    const model = useSettings.getState().llmModel;
    const history = get().messages.slice(-HISTORY_TURNS).map((m): ChatMessage => ({ role: m.role, content: m.text }));
    const system: ChatMessage[] = [
      { role: 'system', content: [COUNSELOR_RULES, ...extraRules].join('\n\n') },
      { role: 'system', content: essayContext(essay) },
    ];
    // Everything the student has written or said: quoting any of it is fine.
    const studentText = [docText(essay.doc), ...get().messages.filter((m) => m.role === 'user').map((m) => m.text), turn.content].join('\n');

    abort = new AbortController();
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
        if (looksDrafted(sentences.slice(0, voiced + 1).join(' '), studentText).drafted) {
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
        abort!.signal,
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
    } else {
      voice(text, true);
    }
    return text;
  }

  async function exchange(essay: EssayView & { id: string }, shown: string | null, turn: ChatMessage, extraRules: string[], spoken = false) {
    if (get().busy) return;
    set({ busy: true, error: null });
    const stage = essay.stage as Stage;
    const save = async (text: string) => {
      const row: ChatRow = { essayId: essay.id, ts: Date.now(), role: 'assistant', text, stage };
      row.id = await db.chats.add(row);
      if (get().essayId === essay.id) set((s) => ({ messages: [...s.messages, row] }));
    };
    try {
      if (shown !== null) {
        const mine: ChatRow = { essayId: essay.id, ts: Date.now(), role: 'user', text: shown, stage };
        mine.id = await db.chats.add(mine);
        set((s) => ({ messages: [...s.messages, mine] }));
      }
      const speakIt = spoken && useSettings.getState().speakReplies;
      await save(await reply(essay, turn, speakIt ? [...extraRules, SPOKEN_RULES] : extraRules, speakIt));
    } catch (err) {
      const stopped = err instanceof Error && err.name === 'AbortError';
      // Cut off by the writer: keep what had been said, marked as unfinished, so the conversation still makes sense.
      const partial = (get().streaming ?? '').trim();
      if (stopped && partial) await save(`${partial} [interrupted]`);
      if (!stopped) set({ error: err instanceof Error ? err.message : 'The counselor could not answer.' });
    } finally {
      set({ busy: false, streaming: null });
    }
  }

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
      const rules = essay.stage === 'brainstorm' ? [BRAINSTORM_RULES] : [];
      if (asksForWriting(text)) rules.push(WRITE_REQUEST_REMINDER);
      await exchange(essay, text, { role: 'user', content: text }, rules, opts.spoken);
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
