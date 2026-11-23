import { useEffect } from 'react';
import { useStore } from '../store';

export function ToastBar() {
  const toast = useStore((s) => s.toast);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => useStore.getState().setToast(null), toast.action ? 10000 : 4000);
    return () => clearTimeout(t);
  }, [toast]);

  if (!toast) return null;
  return (
    <div
      role="status"
      className="fixed bottom-5 left-1/2 z-40 flex -translate-x-1/2 items-center gap-4 rounded-md bg-ink px-4 py-2 text-sm text-white shadow-lg"
    >
      <span>{toast.text}</span>
      {toast.action && (
        <button
          className="font-semibold underline"
          onClick={() => {
            const run = toast.action!;
            useStore.getState().setToast(null);
            void run();
          }}
        >
          {toast.actionLabel}
        </button>
      )}
    </div>
  );
}
