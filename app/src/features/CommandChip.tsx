import { useEffect } from 'react';
import { useStore } from '../store';
import { useSpeech } from '../speech';

const ACTION_LABEL = { cancel: 'Cancel', undo: 'Undo', stop: 'Stop' } as const;

/**
 * Shows what a voice command is doing, with one tap to cancel or undo it.
 * When Scribe has asked a question, the possible answers are buttons here too,
 * so anything that can be answered by voice can also be answered by a click.
 */
export function CommandChip() {
  const chip = useStore((s) => s.chip);
  const pending = useStore((s) => s.pending);
  const speaking = useSpeech((s) => s.speaking);

  useEffect(() => {
    if (!chip || chip.phase === 'pending' || pending) return;
    // A read-back stays up for as long as Scribe is talking.
    if (chip.action === 'stop' && speaking) return;
    const t = setTimeout(() => useStore.getState().clearChip(), chip.action === 'stop' ? 500 : 7000);
    return () => clearTimeout(t);
  }, [chip, speaking, pending]);

  if (!chip && !pending) return null;
  const tone = chip?.phase === 'error' ? 'border-danger text-danger' : 'border-line text-ink';
  return (
    <div className="pointer-events-none absolute inset-x-0 top-3 z-30 flex justify-center px-4">
      <div
        data-testid="command-chip"
        data-phase={pending ? 'question' : chip?.phase}
        role="status"
        className={`pointer-events-auto flex max-w-2xl flex-wrap items-center gap-x-3 gap-y-1 rounded-2xl border bg-white px-4 py-1.5 text-sm shadow-md ${tone}`}
      >
        <span>{pending ? pending.question : chip?.text}</span>
        {pending
          ? pending.answers.map((a, i) => (
              <button key={a.label} className="font-semibold text-accent underline" onClick={() => useStore.getState().choosePending(i)}>
                {a.label}
              </button>
            ))
          : chip?.action && (
              <button className="font-semibold text-accent underline" onClick={() => useStore.getState().chipAction()}>
                {ACTION_LABEL[chip.action]}
              </button>
            )}
      </div>
    </div>
  );
}
