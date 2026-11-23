/** What the counselor is shown about an essay: a read-only view, built in one place. */
import { useStore } from '../store';
import { useCounselor } from '../llm/counselor';
import { useMemory } from '../memory/store';
import { buildVoice } from '../memory/voice';
import { collegeNotes, useColleges } from '../colleges/store';
import type { EssayRow } from '../db/schema';

/** The student's voice as measured from all their essays and what they said while brainstorming. */
export const voiceFor = (e: EssayRow) => {
  const { rows, enabled } = useMemory.getState();
  const brainstorm = useCounselor.getState().messages.filter((m) => m.role === 'user' && m.stage === 'brainstorm').map((m) => m.text);
  return buildVoice(useStore.getState().essays.filter((x) => x.accountId === e.accountId), e, rows, enabled, brainstorm);
};

export const viewOf = (e: EssayRow) => {
  const { colleges, rubrics, principles } = useColleges.getState();
  return {
    memoryNotes: voiceFor(e).notes,
    id: e.id, accountId: e.accountId, title: e.title, stage: e.stage, promptText: e.promptText ?? '',
    wordCount: e.wordCount, wordLimit: e.wordLimit ?? null, doc: e.doc,
    collegeNotes: collegeNotes(colleges.find((c) => c.id === e.collegeId), rubrics, principles),
  };
};

export const currentEssay = () => {
  const s = useStore.getState();
  return s.essays.find((e) => e.id === s.currentId) ?? null;
};
