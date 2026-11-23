import { useState } from 'react';
import { ArrowLeft, Trash2, X } from 'lucide-react';
import { useStore } from '../store';
import { useMemory } from '../memory/store';
import { computeProfile, describeRhythm, MIN_WORDS_FOR_PROFILE } from '../memory/profile';
import { docText } from '../doc/types';
import type { MemoryRow } from '../db/schema';

function Item({ row, children }: { row: MemoryRow; children?: React.ReactNode }) {
  const memory = useMemory.getState();
  return (
    <li data-testid={`memory-${row.kind}`} className="flex items-start gap-2 rounded-md border border-line bg-white p-3">
      <div className="min-w-0 flex-1 space-y-1">
        <textarea
          aria-label={`Edit ${row.kind} note`}
          rows={row.text.length > 90 ? 3 : 1}
          defaultValue={row.text}
          onBlur={(e) => {
            const text = e.target.value.trim();
            if (text && text !== row.text) void memory.update(row.id, { text });
          }}
          className="w-full resize-y rounded border border-transparent bg-transparent px-1 text-sm hover:border-line focus:border-line"
        />
        {row.quote && <q className="block px-1 font-serif text-sm text-muted">{row.quote}</q>}
        <p className="px-1 text-xs text-muted">
          {row.source === 'model' ? 'Written by the local model from your writing' : 'From you'}
          {row.essayTitle ? ` · ${row.essayTitle}` : ''}
        </p>
        {children}
      </div>
      <button aria-label={`Delete this ${row.kind} note`} title="Delete" onClick={() => void memory.remove(row.id)} className="rounded p-1.5 text-muted hover:bg-panel hover:text-danger">
        <Trash2 size={16} />
      </button>
    </li>
  );
}

/** Everything Scribe remembers about how you write. You can see, change and delete all of it. */
export function MemoryScreen() {
  const essays = useStore((s) => s.essays);
  const { rows, enabled, busy, error } = useMemory();
  const memory = useMemory.getState();
  const [newWord, setNewWord] = useState('');
  const [newTone, setNewTone] = useState('');

  const of = (kind: MemoryRow['kind']) => rows.filter((r) => r.kind === kind);
  const profile = computeProfile(essays.map((e) => docText(e.doc)), { excluded: of('excluded-word').map((r) => r.text), added: of('word').map((r) => r.text) });
  const sources = essays.map((e) => ({ essayId: e.id, title: e.title, text: docText(e.doc) }));

  function removeWord(word: string) {
    const added = of('word').find((r) => r.text.toLowerCase() === word);
    if (added) void memory.remove(added.id);
    // A word counted from the essays is hidden by remembering that it is not yours.
    else void memory.add({ kind: 'excluded-word', text: word, source: 'you' });
  }

  return (
    <div className="flex min-w-0 flex-1 flex-col overflow-y-auto">
      <div className="mx-auto w-full max-w-3xl space-y-8 p-6">
        <div className="flex items-center justify-between">
          <button onClick={() => memory.setScreenOpen(false)} className="flex items-center gap-1 text-sm text-accent">
            <ArrowLeft size={14} /> Back to essays
          </button>
          <button
            onClick={() =>
              useStore.setState({
                confirm: {
                  title: 'Delete everything Scribe remembers about your writing?',
                  body: 'This removes every note below and turns learning off. Your essays are not touched.',
                  items: [`${rows.length} remembered ${rows.length === 1 ? 'item' : 'items'}`],
                  confirmLabel: 'Delete all memory',
                  onConfirm: async () => {
                    await memory.deleteAll();
                    await memory.setEnabled(false);
                  },
                },
              })
            }
            className="rounded-md border border-line px-2 py-1 text-sm text-danger"
          >
            Delete all memory
          </button>
        </div>

        <header className="space-y-2">
          <h2 className="font-serif text-3xl">My voice and memory</h2>
          <p className="text-sm text-muted">
            What Scribe has learned about how you write, so its feedback keeps your essays sounding like you. It is stored only on this Mac, tied to your
            account, and never sent anywhere.
          </p>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" aria-label="Learn from my writing" checked={enabled} onChange={(e) => void memory.setEnabled(e.target.checked)} />
            Learn from my writing and use it in feedback
          </label>
          {!enabled && <p className="text-sm text-muted">Memory is off. Nothing is being learned, and nothing below is used.</p>}
        </header>

        <section className="space-y-2">
          <h3 className="font-semibold">Sentence rhythm</h3>
          {profile.ready ? (
            <p data-testid="rhythm" className="text-sm">{describeRhythm(profile)}</p>
          ) : (
            <p data-testid="rhythm" className="text-sm text-muted">
              Not enough writing yet ({profile.wordCount} of about {MIN_WORDS_FOR_PROFILE} words). This is measured from your essays as you write.
            </p>
          )}
          <p className="text-xs text-muted">Counted from your essays each time, so it changes as you write. Turn memory off above to stop it being used.</p>
        </section>

        <section className="space-y-2">
          <h3 className="font-semibold">Words I use often</h3>
          <ul data-testid="vocabulary" className="flex flex-wrap gap-1.5">
            {profile.vocabulary.map((v) => (
              <li key={v.word} className="flex items-center gap-1 rounded-full border border-line bg-white py-0.5 pl-2.5 pr-1 text-sm">
                {v.word}
                {v.count > 0 && <span className="text-xs text-muted">{v.count}</span>}
                <button aria-label={`Remove ${v.word}`} title="Not one of my words" onClick={() => removeWord(v.word)} className="rounded-full p-0.5 text-muted hover:bg-panel">
                  <X size={12} />
                </button>
              </li>
            ))}
            {profile.vocabulary.length === 0 && <li className="text-sm text-muted">None yet. A word shows up here once you have used it three times.</li>}
          </ul>
          <form
            className="flex gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              const word = newWord.trim().toLowerCase();
              if (!word) return;
              const hidden = of('excluded-word').find((r) => r.text.toLowerCase() === word);
              if (hidden) void memory.remove(hidden.id);
              else void memory.add({ kind: 'word', text: word, source: 'you' });
              setNewWord('');
            }}
          >
            <input aria-label="Add a word" value={newWord} onChange={(e) => setNewWord(e.target.value)} placeholder="Add a word that is yours" className="w-64 rounded border border-line bg-white px-2 py-1 text-sm" />
            <button type="submit" className="rounded-md border border-line bg-white px-2 py-1 text-sm">
              Add
            </button>
          </form>
        </section>

        <section className="space-y-2">
          <div className="flex items-center justify-between">
            <h3 className="font-semibold">How I write</h3>
            <button disabled={busy || !enabled} onClick={() => void memory.refreshFromWriting(sources)} className="rounded-md bg-accent px-2 py-1 text-sm font-medium text-white">
              {busy ? 'Reading your writing…' : 'Describe my voice from my essays'}
            </button>
          </div>
          <p className="text-xs text-muted">The local model writes these from your essays; each rests on a line of yours. Edit or delete any you disagree with.</p>
          {error && <p role="alert" className="text-sm text-danger">{error}</p>}
          <ul className="space-y-2">
            {of('tone').map((r) => (
              <Item key={r.id} row={r} />
            ))}
          </ul>
          <form
            className="flex gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              if (!newTone.trim()) return;
              void memory.add({ kind: 'tone', text: newTone.trim(), source: 'you' });
              setNewTone('');
            }}
          >
            <input aria-label="Add a note about how you write" value={newTone} onChange={(e) => setNewTone(e.target.value)} placeholder="Add your own note, e.g. I never use semicolons" className="flex-1 rounded border border-line bg-white px-2 py-1 text-sm" />
            <button type="submit" className="rounded-md border border-line bg-white px-2 py-1 text-sm">
              Add
            </button>
          </form>
        </section>

        <section className="space-y-2">
          <h3 className="font-semibold">Stories I have already used</h3>
          <p className="text-xs text-muted">So the counselor can tell you when a new essay repeats one.</p>
          <ul className="space-y-2">
            {of('story').map((r) => (
              <Item key={r.id} row={r} />
            ))}
          </ul>
          {of('story').length === 0 && <p className="text-sm text-muted">None yet. They are added when you press “Describe my voice from my essays”.</p>}
        </section>

        <section className="space-y-2">
          <h3 className="font-semibold">Feedback I accepted or rejected</h3>
          <p className="text-xs text-muted">Marked with “Useful” or “Not for me” under a counselor reply. Rejected advice is not offered again.</p>
          <ul className="space-y-2">
            {of('feedback').map((r) => (
              <Item key={r.id} row={r}>
                <p className={`px-1 text-xs font-medium ${r.verdict === 'accepted' ? 'text-accent' : 'text-danger'}`}>{r.verdict === 'accepted' ? 'Useful' : 'Not for me'}</p>
              </Item>
            ))}
          </ul>
          {of('feedback').length === 0 && <p className="text-sm text-muted">None yet.</p>}
        </section>
      </div>
    </div>
  );
}
