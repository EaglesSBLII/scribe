import { useStore } from '../store';
import { promptsFor, useColleges } from '../colleges/store';
import type { EssayRow } from '../db/schema';

/** Ties the essay to a college and one of its prompts. */
export function PromptPicker({ essay }: { essay: EssayRow }) {
  const colleges = useColleges((s) => s.colleges);
  const allPrompts = useColleges((s) => s.prompts);
  const college = colleges.find((c) => c.id === essay.collegeId);
  const prompts = promptsFor(college, allPrompts);
  const prompt = prompts.find((p) => p.id === essay.promptId);
  const store = useStore.getState();
  const unverified = (college && !college.verified) || (prompt && !prompt.verified);

  return (
    <div className="flex min-w-0 items-center gap-2 text-sm">
      <select
        aria-label="College"
        value={essay.collegeId ?? ''}
        onChange={(e) => store.setEssayPrompt(essay.id, e.target.value || null, null)}
        className="max-w-48 rounded border border-line bg-white px-1.5 py-1"
      >
        <option value="">No college</option>
        {colleges.map((c) => (
          <option key={c.id} value={c.id}>
            {c.name}
          </option>
        ))}
      </select>
      <select
        aria-label="Prompt"
        value={essay.promptId ?? ''}
        disabled={!college}
        onChange={(e) => store.setEssayPrompt(essay.id, essay.collegeId, e.target.value || null)}
        className="min-w-0 max-w-72 flex-1 truncate rounded border border-line bg-white px-1.5 py-1"
      >
        <option value="">{college ? (prompts.length ? 'Choose a prompt' : 'No prompts stored') : 'Choose a college first'}</option>
        {prompts.map((p) => (
          <option key={p.id} value={p.id}>
            {p.label}
            {p.wordLimit ? ` (${p.wordLimit} words)` : ''}
            {p.verified ? '' : ' · unverified'}
          </option>
        ))}
      </select>
      {unverified && (
        <span data-testid="unverified-badge" title="Not confirmed on an official page for this cycle. Check the school's site." className="shrink-0 rounded bg-[#f6ecc9] px-1.5 py-0.5 text-xs font-medium text-[#6b5310]">
          unverified
        </span>
      )}
    </div>
  );
}
