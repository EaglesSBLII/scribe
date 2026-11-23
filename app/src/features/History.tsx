import { useState } from 'react';
import { X } from 'lucide-react';
import { useStore } from '../store';
import { docText } from '../doc/types';
import { dateTime } from './time';

export function History() {
  const versions = useStore((s) => s.versions);
  const [openId, setOpenId] = useState<number | null>(null);
  const store = useStore.getState();

  return (
    <aside aria-label="Version history" className="flex w-80 shrink-0 flex-col border-l border-line bg-panel">
      <div className="flex items-center justify-between px-4 py-4">
        <h2 className="font-semibold">Version history</h2>
        <button aria-label="Close version history" onClick={() => void store.openHistory(false)} className="rounded p-1 text-muted hover:bg-white">
          <X size={16} />
        </button>
      </div>
      <ul className="flex-1 space-y-2 overflow-y-auto px-3 pb-4">
        {versions.length === 0 && (
          <li className="px-1 text-sm text-muted">
            No versions yet. One is saved automatically every 10 minutes of writing, before any large deletion, and
            whenever you press Save a version.
          </li>
        )}
        {versions.map((v) => (
          <li key={v.id} data-testid="version" className="rounded-md bg-white p-3 text-sm shadow-sm">
            <button className="block w-full text-left" aria-expanded={openId === v.id} onClick={() => setOpenId(openId === v.id ? null : v.id!)}>
              <span className="block font-medium">{dateTime(v.ts)}</span>
              <span className="block text-xs text-muted">
                {v.reason} · {v.wordCount} words
              </span>
            </button>
            {openId === v.id && (
              <>
                <p className="mt-2 max-h-48 overflow-y-auto whitespace-pre-wrap border-t border-line pt-2 font-serif text-sm">
                  {docText(v.doc) || 'Empty'}
                </p>
                <button onClick={() => store.restoreVersion(v)} className="mt-2 rounded-md border border-line px-2 py-1 text-sm">
                  Restore this version
                </button>
              </>
            )}
          </li>
        ))}
      </ul>
    </aside>
  );
}
