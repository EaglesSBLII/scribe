import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { useStore } from '../store';
import { promptsFor, useColleges } from '../colleges/store';
import { isIpedsId, searchColleges, type CollegeOption } from '../colleges/usColleges';
import type { EssayRow } from '../db/schema';

const MOST = 50;
const NO_COLLEGE: CollegeOption = { id: '', name: 'No college', place: '', website: '', researched: false, verifiedPrompts: false };

/** What the list says under a school's name about its prompts. */
function promptNote(o: CollegeOption): string {
  if (!o.id) return 'Not tied to a school';
  if (o.verifiedPrompts) return 'Verified prompts';
  return o.researched ? 'No verified prompts' : 'Paste your own prompt';
}

/** A text box that finds a college by name, city or state. Researched schools are listed first. */
function CollegeBox({ essay }: { essay: EssayRow }) {
  const colleges = useColleges((s) => s.colleges);
  const prompts = useColleges((s) => s.prompts);
  const us = useColleges((s) => s.us);
  const current = colleges.find((c) => c.id === essay.collegeId);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const [failed, setFailed] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const listId = useId();

  const local = useMemo(
    () => colleges.map((college) => ({ college, verifiedPrompts: promptsFor(college, prompts).some((p) => p.verified) })),
    [colleges, prompts],
  );
  const { items, total } = useMemo(() => {
    if (!open) return { items: [] as CollegeOption[], total: 0 };
    const found = searchColleges(query, local, us ?? [], MOST);
    return { items: query.trim() ? found.options : [NO_COLLEGE, ...found.options], total: found.total };
  }, [open, query, local, us]);

  useEffect(() => {
    if (open) document.getElementById(`${listId}-${active}`)?.scrollIntoView({ block: 'nearest' });
  }, [open, active, listId]);

  function show(text = '') {
    setQuery(text);
    setActive(0);
    setOpen(true);
    // The big list is only read once someone looks for a school.
    if (!us) useColleges.getState().loadUs().then(() => setFailed(false), () => setFailed(true));
  }

  function close() {
    setOpen(false);
    setQuery('');
  }

  function choose(option: CollegeOption) {
    if (option.us) useColleges.getState().addUsCollege(option.us);
    if (option.id !== (essay.collegeId ?? '')) useStore.getState().setEssayPrompt(essay.id, option.id || null, null);
    close();
    // The name stays selected, so typing straight away starts a new search.
    requestAnimationFrame(() => input.current?.select());
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!open) return show();
      const step = e.key === 'ArrowDown' ? 1 : -1;
      setActive((i) => Math.min(Math.max(i + step, 0), Math.max(items.length - 1, 0)));
    } else if (e.key === 'Enter' && open) {
      e.preventDefault();
      if (items[active]) choose(items[active]);
    } else if (e.key === 'Escape' && open) {
      e.preventDefault();
      e.stopPropagation();
      close();
      requestAnimationFrame(() => input.current?.select());
    }
  }

  const more = total - (items.length - (query.trim() ? 0 : 1));
  return (
    <div className="relative w-56 max-w-full shrink-0 sm:w-64">
      <input
        ref={input}
        type="text"
        role="combobox"
        aria-label="College"
        aria-autocomplete="list"
        aria-expanded={open}
        aria-controls={listId}
        aria-activedescendant={open && items[active] ? `${listId}-${active}` : undefined}
        data-college-id={essay.collegeId ?? ''}
        autoComplete="off"
        spellCheck={false}
        placeholder={open && current ? current.name : 'Search colleges'}
        title={current?.name}
        value={open ? query : (current?.name ?? '')}
        onFocus={() => show()}
        onClick={() => !open && show()}
        onChange={(e) => show(e.target.value)}
        onKeyDown={onKeyDown}
        onBlur={close}
        className="w-full truncate rounded border border-line bg-paper px-1.5 py-1 text-ink placeholder:text-muted"
      />
      <ul
        id={listId}
        role="listbox"
        aria-label="Matching schools"
        hidden={!open}
        className="absolute left-0 top-full z-30 mt-1 max-h-80 w-full overflow-y-auto rounded border border-line bg-paper py-1 shadow-lg"
      >
        {items.map((o, i) => (
          <li
            key={o.id}
            id={`${listId}-${i}`}
            role="option"
            aria-selected={i === active}
            data-college-id={o.id}
            // Keeps the text box focused, so the click lands before the list closes.
            onMouseDown={(e) => e.preventDefault()}
            onMouseMove={() => setActive(i)}
            onClick={() => choose(o)}
            className={`cursor-pointer px-2 py-1.5 ${i === active ? 'bg-panel' : ''}`}
          >
            <span className="block text-ink">{o.name}</span>
            <span className="block text-xs text-muted">
              {o.place && `${o.place} · `}
              <span className={o.verifiedPrompts ? 'font-medium text-accent' : undefined}>{promptNote(o)}</span>
            </span>
          </li>
        ))}
        {open && items.length === 0 && us && <li role="presentation" className="px-2 py-1.5 text-xs text-muted">No school matches. Try the city or state.</li>}
        {open && more > 0 && <li role="presentation" className="px-2 py-1.5 text-xs text-muted">{more.toLocaleString()} more. Keep typing to narrow the list.</li>}
        {open && !us && (
          <li role="presentation" className="px-2 py-1.5 text-xs text-muted">
            {failed ? 'The full list of US colleges could not be loaded.' : 'Loading more US colleges…'}
          </li>
        )}
      </ul>
    </div>
  );
}

/** Where a student pastes the prompt of a school whose prompts Scribe has not checked. */
function PastedPrompt({ essay, website }: { essay: EssayRow; website: string }) {
  const [text, setText] = useState(essay.promptText ?? '');
  useEffect(() => setText(essay.promptText ?? ''), [essay.id, essay.collegeId, essay.promptText]);
  let host = '';
  try {
    host = website ? new URL(website).hostname.replace(/^www\./, '') : '';
  } catch {
    host = '';
  }
  return (
    <div data-testid="unresearched-note" className="max-w-xl basis-full space-y-1">
      <p className="text-xs text-muted">
        Prompts for this school have not been checked. Copy this year's prompt from{' '}
        {host ? (
          <a href={website} target="_blank" rel="noreferrer noopener" className="font-medium text-accent underline">
            {host}
          </a>
        ) : (
          "the school's official website"
        )}{' '}
        and paste it below.
      </p>
      <textarea
        aria-label="Paste this school's prompt"
        rows={2}
        value={text}
        placeholder="Paste the question this essay answers."
        onChange={(e) => setText(e.target.value)}
        onBlur={() => text.trim() !== (essay.promptText ?? '') && useStore.getState().setPromptText(essay.id, text)}
        className="w-full resize-y rounded border border-line bg-paper px-2 py-1 text-sm text-ink placeholder:text-muted"
      />
    </div>
  );
}

/** Ties the essay to a college and one of its prompts. */
export function PromptPicker({ essay }: { essay: EssayRow }) {
  const colleges = useColleges((s) => s.colleges);
  const allPrompts = useColleges((s) => s.prompts);
  const college = colleges.find((c) => c.id === essay.collegeId);
  const prompts = promptsFor(college, allPrompts);
  const prompt = prompts.find((p) => p.id === essay.promptId);
  const store = useStore.getState();
  // A school from the big US list: name and website only, so the student brings the prompt.
  const unresearched = isIpedsId(essay.collegeId) && prompts.length === 0;
  const unverified = unresearched || (college && !college.verified) || (prompt && !prompt.verified);

  return (
    <div className="flex min-w-0 max-w-full flex-wrap items-center gap-2 text-sm">
      <CollegeBox essay={essay} />
      {!unresearched && (
        <select
          aria-label="Prompt"
          value={essay.promptId ?? ''}
          disabled={!college}
          onChange={(e) => store.setEssayPrompt(essay.id, essay.collegeId, e.target.value || null)}
          className="min-w-0 max-w-72 flex-1 truncate rounded border border-line bg-paper px-1.5 py-1"
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
      )}
      {unverified && (
        <span data-testid="unverified-badge" title="Not confirmed on an official page for this cycle. Check the school's site." className="shrink-0 rounded bg-warn-soft px-1.5 py-0.5 text-xs font-medium text-warn">
          unverified
        </span>
      )}
      {unresearched && <PastedPrompt essay={essay} website={college?.wantsSourceUrl ?? ''} />}
    </div>
  );
}
