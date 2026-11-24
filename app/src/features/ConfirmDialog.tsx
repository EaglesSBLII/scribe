import { useEffect, useRef } from 'react';
import { useStore } from '../store';

/** The only place a large deletion can be authorised. Shows exactly what goes. */
export function ConfirmDialog() {
  const request = useStore((s) => s.confirm);
  const cancelRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!request) return;
    cancelRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') void useStore.getState().closeConfirm(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [request]);

  if (!request) return null;
  const close = (ok: boolean) => void useStore.getState().closeConfirm(ok);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-6">
      <div
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="confirm-title"
        className="w-full max-w-lg rounded-lg bg-surface p-6 shadow-xl"
      >
        <h2 id="confirm-title" className="text-lg font-semibold">
          {request.title}
        </h2>
        <p className="mt-2 text-sm text-muted">{request.body}</p>
        {request.items.length > 0 && (
          <div
            data-testid="confirm-items"
            className="mt-4 max-h-64 space-y-2 overflow-y-auto rounded-md border border-line bg-paper p-3 font-serif text-sm"
          >
            {request.items.map((item, i) => (
              <p key={i} className="whitespace-pre-wrap">
                {item}
              </p>
            ))}
          </div>
        )}
        <div className="mt-6 flex justify-end gap-2">
          <button ref={cancelRef} onClick={() => close(false)} className="rounded-md border border-line px-3 py-1.5">
            Cancel
          </button>
          <button onClick={() => close(true)} className="rounded-md bg-danger px-3 py-1.5 font-medium text-on-accent">
            {request.confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
