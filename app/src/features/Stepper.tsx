import { useStore } from '../store';
import { useCounselor } from '../llm/counselor';
import type { EssayRow, Stage } from '../db/schema';
import { useSettings } from '../settings';

const STAGES: { id: Stage; label: string; hint: string }[] = [
  { id: 'brainstorm', label: 'Brainstorm', hint: 'Talk through your stories with the counselor' },
  { id: 'draft', label: 'Draft', hint: 'Just dictate; no interruptions' },
  { id: 'refine', label: 'Refine', hint: 'Feedback and voice edits' },
  { id: 'finish', label: 'Finish', hint: 'Final checks and export' },
];

/** Brainstorm -> Draft -> Refine -> Finish. Any step can be opened at any time. */
export function Stepper({ essay }: { essay: EssayRow }) {
  const at = STAGES.findIndex((s) => s.id === essay.stage);
  return (
    <ol aria-label="Essay stage" className="flex items-center gap-1 text-sm">
      {STAGES.map((s, i) => (
        <li key={s.id} className="flex items-center gap-1">
          {i > 0 && <span aria-hidden="true" className="h-px w-4 bg-line" />}
          <button
            title={s.hint}
            aria-current={i === at ? 'step' : undefined}
            onClick={() => {
              useStore.getState().setStage(essay.id, s.id);
              // Drafting is quiet; every other stage works with the counselor.
              useCounselor.getState().setOpen(s.id !== 'draft');
              // Brainstorm is a conversation by default; leaving it goes back to quiet drafting.
              const mode = useSettings.getState().counselorMode;
              if (s.id === 'brainstorm') void useSettings.getState().set('counselorMode', 'conversation');
              else if (essay.stage === 'brainstorm' && mode === 'conversation') void useSettings.getState().set('counselorMode', 'draft');
            }}
            className={`rounded-full px-3 py-1 ${
              i === at ? 'bg-accent font-medium text-white' : i < at ? 'bg-[#e3efe9] text-accent' : 'text-muted hover:bg-panel'
            }`}
          >
            {i + 1}. {s.label}
          </button>
        </li>
      ))}
    </ol>
  );
}
