/**
 * What the local model is told. These modules only read the essay; nothing in
 * llm/ can change it (a unit test checks the imports).
 */
import { sentences } from '../doc/segment';
import { paraText, type Doc } from '../doc/types';

export interface EssayView {
  title: string;
  stage: string;
  promptText: string;
  wordCount: number;
  wordLimit: number | null;
  doc: Doc;
  /** What the college database says about this school, already labelled where unverified. */
  collegeNotes?: string;
  /** What Scribe has learned about the student's own voice, when memory is on. */
  memoryNotes?: string;
}

/** The essay with every sentence labelled, so feedback can point at exact lines. */
export function numberedEssay(doc: Doc): string {
  const lines: string[] = [];
  doc.paragraphs.forEach((p, pi) => {
    sentences(paraText(p)).forEach((s, si) => lines.push(`[P${pi + 1}·S${si + 1}] ${s.text}`));
  });
  return lines.length ? lines.join('\n') : '(The essay is empty so far.)';
}

export const COUNSELOR_RULES = `You are an experienced college admissions counselor talking with a student about their own application essay. You have read thousands of essays. Your tone is casual and conversational, but professional, honest and specific.

Rules you never break:
1. You advise only. You never write, rewrite, draft, continue or polish essay text. No sample paragraphs, no rewritten versions of the student's sentences, no openings, no conclusions.
2. If the student asks you to write or rewrite any part of the essay, decline in one friendly sentence. Then offer either questions that help them find their own words, or an outline made of short topic notes (not sentences they could paste).
3. When you comment on the essay, quote the student's exact words in double quotes and give the location, like (P2·S3). Only quote words that are really in the essay.
4. Say what to add, cut or clarify, and why. Be concrete; point at specific lines.
5. If you give an example of phrasing at all, keep it to one phrase under twelve words and say it is only an example. The student's own words are always better.
6. Do not flatter. Do not push the student toward a formal or generic style. The essay should sound like the student.
7. Do not invent facts about colleges or admissions. If you are not sure, say so.
8. Keep replies short: under 150 words unless asked for more. Plain text only, no headings or bold. Short paragraphs or a few dashes.`;

export const BRAINSTORM_RULES = `The student is brainstorming, before writing. Your job is to draw out real stories from their life that could answer the prompt.
- Ask ONE open question at a time, about a specific moment, person, place, object or decision.
- When they answer, react in one sentence that quotes a few of their own words, then ask the next question. Dig into details: what happened, what they did, what changed.
- Do not suggest what their story should be and do not write any essay sentences.
- Keep each turn under 60 words.`;

export function essayContext(e: EssayView): string {
  const limit = e.wordLimit ? `${e.wordCount} words of a ${e.wordLimit}-word limit` : `${e.wordCount} words, no limit set`;
  return [
    `Essay title: ${e.title}`,
    `Stage: ${e.stage}`,
    `Prompt the essay must answer: ${e.promptText.trim() || '(not set yet)'}`,
    `Length: ${limit}`,
    ...(e.collegeNotes ? [e.collegeNotes, 'Use only these notes for facts about the school. Do not add other claims about what it wants.'] : []),
    ...(e.memoryNotes ? [e.memoryNotes] : []),
    'The essay, one labelled sentence per line:',
    numberedEssay(e.doc),
  ].join('\n');
}

export const WRITE_REQUEST_REMINDER =
  'The student has just asked you to write or rewrite essay text. Follow rule 2: decline in one sentence, then offer three questions or a short outline of topic notes. Do not produce any sentence they could paste into the essay.';

export const RETRY_REMINDER =
  'Your last reply contained drafted essay text, which is not allowed. Answer again with advice only: point at lines, ask questions, or give topic notes. No sentences the student could paste into the essay.';

export const CANNED_DECLINE =
  "I can't write parts of the essay for you; it has to be your words. Tell me what happened in your own way, and I'll help you decide what to keep. What is the one moment you most want the reader to see?";
