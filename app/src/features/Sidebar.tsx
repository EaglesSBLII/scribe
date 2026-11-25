import { useState } from 'react';
import { Archive, ArchiveRestore, ArrowDown, ArrowUp, Fingerprint, Folder, FolderOpen, GraduationCap, MoreHorizontal, Pencil, Plus, SlidersHorizontal, Trash2 } from 'lucide-react';
import { useMemory } from '../memory/store';
import { useSettings } from '../settings';
import { useStore } from '../store';
import { useColleges } from '../colleges/store';
import { flushPending } from '../editorBus';
import type { EssayRow, Stage } from '../db/schema';
import { ago } from './time';
import { useUi } from './ui';

const STAGE_LABEL: Record<Stage, string> = {
  brainstorm: 'Brainstorm',
  draft: 'Draft',
  refine: 'Refine',
  finish: 'Finish',
};

export function Sidebar() {
  const essays = useStore((s) => s.essays);
  const currentId = useStore((s) => s.currentId);
  const account = useStore((s) => s.account);
  const colleges = useColleges((s) => s.colleges);
  const prompts = useColleges((s) => s.prompts);
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const [dragId, setDragId] = useState<string | null>(null);
  const [closed, setClosed] = useState<ReadonlySet<string>>(new Set());
  const store = useStore.getState();
  const navOpen = useUi((u) => u.navOpen);
  const closeNav = () => useUi.getState().setNavOpen(false);

  const sorted = [...essays].sort((a, b) => a.order - b.order);
  const active = sorted.filter((e) => !e.archived);
  const archived = sorted.filter((e) => e.archived);

  // Essays written for a college sit in that college's folder; the rest stay loose.
  // A folder stands where its first essay stands.
  const folders = new Map<string, EssayRow[]>();
  for (const e of active) if (e.collegeId) folders.set(e.collegeId, [...(folders.get(e.collegeId) ?? []), e]);

  /** Move within the essay's own folder (or among the loose essays) by swapping places with a neighbour. */
  function nudge(essay: EssayRow, delta: number) {
    const beside = active.filter((e) => e.collegeId === essay.collegeId);
    const neighbour = beside[beside.indexOf(essay) + delta];
    if (neighbour) store.moveEssay(essay.id, sorted.indexOf(neighbour));
    setMenuFor(null);
  }

  function row(essay: EssayRow) {
    const isCurrent = essay.id === currentId;
    return (
      <li
        key={essay.id}
        data-testid="essay-tab"
        draggable={!essay.archived && renaming !== essay.id}
        onDragStart={() => setDragId(essay.id)}
        onDragOver={(e) => e.preventDefault()}
        onDrop={() => {
          if (dragId && dragId !== essay.id) store.moveEssay(dragId, sorted.indexOf(essay));
          setDragId(null);
        }}
        className={`group relative rounded-md ${isCurrent ? 'bg-surface shadow-sm' : 'hover:bg-raised'}`}
      >
        {renaming === essay.id ? (
          <input
            autoFocus
            aria-label="Essay title"
            defaultValue={essay.title}
            className="m-1 w-[calc(100%-0.5rem)] rounded border border-line px-2 py-1 text-sm"
            onBlur={(e) => {
              store.renameEssay(essay.id, e.target.value);
              setRenaming(null);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') e.currentTarget.blur();
              if (e.key === 'Escape') setRenaming(null);
            }}
          />
        ) : (
          <button
            className="block w-full px-3 py-2 pr-9 text-left"
            aria-current={isCurrent ? 'page' : undefined}
            onClick={() => {
              if (essay.archived) return;
              closeNav();
              void store.openEssay(essay.id);
            }}
            onDoubleClick={() => setRenaming(essay.id)}
          >
            <span className="block truncate text-sm font-medium">{essay.title}</span>
            {essay.archived && essay.collegeId && (
              <span className="block truncate text-xs text-muted">{collegeName(essay.collegeId)}</span>
            )}
            {essay.promptId && (
              <span className="block truncate text-xs text-muted">{prompts.find((p) => p.id === essay.promptId)?.label ?? ''}</span>
            )}
            <span className="block text-xs text-muted">
              {essay.archived ? 'Archived' : STAGE_LABEL[essay.stage]} · {essay.wordCount} words · {ago(essay.updatedAt)}
            </span>
          </button>
        )}
        <button
          aria-label={`Options for ${essay.title}`}
          aria-expanded={menuFor === essay.id}
          onClick={() => setMenuFor(menuFor === essay.id ? null : essay.id)}
          className="absolute right-1 top-2 rounded p-1 text-muted hover:bg-panel"
        >
          <MoreHorizontal size={16} />
        </button>
        {menuFor === essay.id && (
          <div role="menu" className="absolute right-1 top-9 z-20 w-44 rounded-md border border-line bg-surface py-1 text-sm shadow-lg">
            <MenuItem icon={<Pencil size={14} />} label="Rename" onClick={() => { setRenaming(essay.id); setMenuFor(null); }} />
            {!essay.archived && (
              <>
                <MenuItem icon={<ArrowUp size={14} />} label="Move up" onClick={() => nudge(essay, -1)} />
                <MenuItem icon={<ArrowDown size={14} />} label="Move down" onClick={() => nudge(essay, 1)} />
              </>
            )}
            {essay.archived ? (
              <MenuItem icon={<ArchiveRestore size={14} />} label="Unarchive" onClick={() => { store.setArchived(essay.id, false); setMenuFor(null); }} />
            ) : (
              <MenuItem icon={<Archive size={14} />} label="Archive" onClick={() => { store.setArchived(essay.id, true); setMenuFor(null); }} />
            )}
            <MenuItem danger icon={<Trash2 size={14} />} label="Delete" onClick={() => { store.requestDeleteEssay(essay.id); setMenuFor(null); }} />
          </div>
        )}
      </li>
    );
  }

  function collegeName(id: string) {
    return colleges.find((c) => c.id === id)?.name ?? 'College';
  }

  function folder(collegeId: string, inside: EssayRow[]) {
    const name = collegeName(collegeId);
    const open = !closed.has(collegeId);
    return (
      <li key={`folder-${collegeId}`} data-testid="college-folder">
        <div className="group flex items-center rounded-md hover:bg-raised">
          <button
            className="flex min-w-0 flex-1 items-center gap-2 px-3 py-1.5 text-left text-sm font-medium"
            aria-expanded={open}
            onClick={() => {
              const next = new Set(closed);
              if (open) next.add(collegeId);
              else next.delete(collegeId);
              setClosed(next);
            }}
          >
            {open ? <FolderOpen size={15} className="shrink-0 text-accent" /> : <Folder size={15} className="shrink-0 text-accent" />}
            <span className="truncate">{name}</span>
            <span className="shrink-0 text-xs font-normal text-muted">{inside.length}</span>
          </button>
          <button
            aria-label={`New essay for ${name}`}
            title={`New essay for ${name}`}
            className="mr-1 rounded p-1 text-muted hover:bg-panel"
            onClick={async () => {
              closeNav();
              const before = useStore.getState().currentId;
              await store.createEssay();
              const made = useStore.getState().currentId;
              if (made && made !== before) useStore.getState().setEssayPrompt(made, collegeId, null);
            }}
          >
            <Plus size={15} />
          </button>
        </div>
        {open && <ul className="ml-3 space-y-1 border-l border-line pl-1 pt-1">{inside.map(row)}</ul>}
      </li>
    );
  }

  return (
    <nav
      aria-label="Essays"
      className={`${navOpen ? 'flex' : 'hidden'} fixed inset-y-0 left-0 z-40 w-72 max-w-[85vw] shrink-0 flex-col border-r border-line bg-panel shadow-xl md:static md:flex md:w-64 md:shadow-none`}
    >
      <div className="flex items-center justify-between px-4 py-4">
        <span className="flex items-center gap-2 font-serif text-xl">
          <img src="./icon.svg" alt="" className="h-7 w-7" />
          Scribe
        </span>
        <button
          onClick={() => {
            closeNav();
            void store.createEssay();
          }}
          className="flex items-center gap-1 rounded-md border border-line px-2 py-1 text-sm text-ink hover:bg-raised"
        >
          <Plus size={14} /> New essay
        </button>
      </div>
      <ul className="flex-1 space-y-1 overflow-y-auto px-2">
        {active.map((e) => {
          if (!e.collegeId) return row(e);
          const inside = folders.get(e.collegeId)!;
          return inside[0] === e ? folder(e.collegeId, inside) : null;
        })}
        {active.length === 0 && <li className="px-3 py-2 text-sm text-muted">No essays yet.</li>}
        {archived.length > 0 && (
          <li className="pt-3">
            <button
              className="px-3 text-xs font-medium uppercase tracking-wide text-muted"
              aria-expanded={showArchived}
              onClick={() => setShowArchived(!showArchived)}
            >
              Archived ({archived.length})
            </button>
          </li>
        )}
        {showArchived && archived.map(row)}
      </ul>
      <div className="border-t border-line px-2 py-2">
        <button
          onClick={() => {
            flushPending();
            closeNav();
            useColleges.getState().setAdminOpen(true);
          }}
          className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-raised"
        >
          <GraduationCap size={16} /> Colleges and prompts
        </button>
        <button
          onClick={() => {
            flushPending();
            closeNav();
            useMemory.getState().setScreenOpen(true);
          }}
          className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-raised"
        >
          <Fingerprint size={16} /> My voice and memory
        </button>
        <button
          onClick={() => {
            flushPending();
            closeNav();
            useSettings.getState().setScreenOpen(true);
          }}
          className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-raised"
        >
          <SlidersHorizontal size={16} /> Settings
        </button>
        <div className="truncate px-2 pt-1 text-xs text-muted" title={account?.email}>
          {account?.email}
        </div>
      </div>
    </nav>
  );
}

function MenuItem(props: { icon: React.ReactNode; label: string; onClick: () => void; danger?: boolean }) {
  return (
    <button
      role="menuitem"
      onClick={props.onClick}
      className={`flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-panel ${props.danger ? 'text-danger' : ''}`}
    >
      {props.icon}
      {props.label}
    </button>
  );
}
