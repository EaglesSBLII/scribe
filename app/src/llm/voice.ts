/**
 * Asks the local model to describe how the student writes and which stories
 * their essays tell. Every note must rest on a quote that is word for word in
 * the student's writing, or it is dropped. Reads only; changes no essay.
 */
import { platform } from '../platform';
import { useSettings } from '../settings';
import { isVerbatim } from './guard';

export interface VoiceSource {
  essayId: string;
  title: string;
  text: string;
}

export interface VoiceNotes {
  tone: { text: string; quote: string }[];
  stories: { essayId: string; essayTitle: string; text: string; quote: string }[];
}

const MAX_WORDS_PER_ESSAY = 500;

export async function describeVoice(sources: VoiceSource[]): Promise<VoiceNotes> {
  const usable = sources.filter((s) => s.text.trim().split(/\s+/).length >= 40).slice(0, 6);
  if (usable.length === 0) return { tone: [], stories: [] };
  const raw = await platform.llmChat({
    model: useSettings.getState().llmModel,
    options: { temperature: 0, seed: 7 },
    format: {
      type: 'object',
      required: ['tone', 'stories'],
      properties: {
        tone: { type: 'array', items: { type: 'object', required: ['note', 'quote'], properties: { note: { type: 'string' }, quote: { type: 'string' } } } },
        stories: {
          type: 'array',
          items: { type: 'object', required: ['essay', 'title', 'quote'], properties: { essay: { type: 'integer' }, title: { type: 'string' }, quote: { type: 'string' } } },
        },
      },
    },
    messages: [
      {
        role: 'system',
        content:
          'You are describing how one student writes, from their own essays, so that feedback can protect their voice. Answer in JSON.\n' +
          '"tone": 3 to 5 notes. Each "note" describes in at most 14 plain words HOW this student writes (for example: dry humour, plain concrete nouns, ends paragraphs on a short line). Describe, do not judge or advise. Each needs a "quote": a line copied EXACTLY from their writing that shows it.\n' +
          '"stories": for each essay, the main story it tells: "essay" is the essay number, "title" is at most 6 words, "quote" is a line copied EXACTLY from that essay.\n' +
          'Never invent a quote. If you cannot find an exact line, leave the item out.',
      },
      {
        role: 'user',
        content: usable.map((s, i) => `ESSAY ${i + 1}: ${s.title}\n${s.text.split(/\s+/).slice(0, MAX_WORDS_PER_ESSAY).join(' ')}`).join('\n\n'),
      },
    ],
  });
  const data = JSON.parse(raw) as { tone?: { note?: unknown; quote?: unknown }[]; stories?: { essay?: unknown; title?: unknown; quote?: unknown }[] };
  const everything = usable.map((s) => s.text).join('\n');
  const notes: VoiceNotes = { tone: [], stories: [] };
  for (const t of data.tone ?? []) {
    if (typeof t.note !== 'string' || typeof t.quote !== 'string' || !t.note.trim()) continue;
    if (isVerbatim(t.quote, everything)) notes.tone.push({ text: t.note.trim(), quote: t.quote.trim() });
  }
  for (const s of data.stories ?? []) {
    const essay = usable[Number(s.essay) - 1];
    if (!essay || typeof s.title !== 'string' || typeof s.quote !== 'string' || !s.title.trim()) continue;
    // The quote must come from that very essay.
    if (isVerbatim(s.quote, essay.text)) notes.stories.push({ essayId: essay.essayId, essayTitle: essay.title, text: s.title.trim(), quote: s.quote.trim() });
  }
  return notes;
}
