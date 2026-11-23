import { useEffect } from 'react';
import { useStore } from '../store';
import { useSpeech } from '../speech';

const ACTION_LABEL = { cancel: 'Cancel', undo: 'Undo', stop: 'Stop' } as const;

/** Shows what a voice command is doing, with one tap to cancel or undo it. */
export function CommandChip() {
  const chip = useStore((s) => s.chip);
  const speaking = useSpeech((s) => s.speaking);

  useEffect(() => {
    if (!chip || chip.phase === 'pending') return;
    // A read-back stays up for as long as Scribe is talking.
    if (chip.action === 'stop' && speaking) return;
    const t = setTimeout(() => useStore.getState().clearChip(), chip.action === 'stop' ? 500 : 7000);
    return () => clearTimeout(t);
  }, [chip, speaking]);

  if (!chip) return null;
  const tone = chip.phase === 'error' ? 'border-danger text-danger' : 'border-line text-ink';
  return (
    <div className="pointer-events-none absolute inset-x-0 top-3 z-30 flex justify-center">
      <div
        data-testid="command-chip"
        data-phase={chip.phase}
        role="status"
        className={`pointer-events-auto flex items-center gap-3 rounded-full border bg-white px-4 py-1.5 text-sm shadow-md ${tone}`}
      >
        <span>{chip.text}</span>
        {chip.action && (
          <button className="font-semibold text-accent underline" onClick={() => useStore.getState().chipAction()}>
            {ACTION_LABEL[chip.action]}
          </button>
        )}
      </div>
    </div>
  );
}
