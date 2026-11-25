import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import { ArrowDown, ArrowUp, Ear, History as HistoryIcon, Menu, MessageCircle, Mic, MicOff, Redo2, Save, Sigma, Trash2, Undo2 } from 'lucide-react';
import { kindOf } from '../paper/layout';
import { RichView } from './RichView';
import { useCounselor } from '../llm/counselor';
import { Stepper } from './Stepper';
import { PromptPicker } from './PromptPicker';
import { useStore } from '../store';
import { paraText, textToNodes, type Inline, type Paragraph } from '../doc/types';
import { tidy } from '../doc/ops';
import { clearPending, registerPending } from '../editorBus';
import { toggleConversation, toggleDictation, useDictation } from '../dictation/session';
import { useSettings } from '../settings';
import { clock } from './time';
import { CommandChip } from './CommandChip';
import { useUi } from './ui';
import { useSync } from '../sync';

const TYPING_SAVE_MS = 500;

function caretOffset(el: HTMLElement): number {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return 0;
  const range = sel.getRangeAt(0);
  const before = document.createRange();
  before.selectNodeContents(el);
  before.setEnd(range.startContainer, range.startOffset);
  return before.toString().length;
}

function setCaret(el: HTMLElement, offset: number) {
  const range = document.createRange();
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  let left = offset;
  let placed = false;
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const len = node.textContent?.length ?? 0;
    if (left <= len) {
      range.setStart(node, left);
      placed = true;
      break;
    }
    left -= len;
  }
  if (!placed) {
    range.selectNodeContents(el);
    range.collapse(false);
  } else {
    range.collapse(true);
  }
  const sel = window.getSelection();
  sel?.removeAllRanges();
  sel?.addRange(range);
}

/** Draw a paragraph's nodes. Flagged words become clickable highlights. */
function drawNodes(el: HTMLElement, nodes: Inline[]) {
  el.replaceChildren(
    ...nodes.map((n, i) => {
      if (n.t !== 'flag') return document.createTextNode(n.t === 'math' ? `$${n.latex}$` : n.text);
      const span = document.createElement('span');
      span.dataset.flag = String(i);
      span.className = 'flag';
      span.textContent = n.text;
      span.title = `Scribe was not sure. Click to change to: ${n.alt.trim()}`;
      return span;
    }),
  );
}

/** Read the paragraph back from the editor, keeping flagged words that were not touched. */
function readNodes(el: HTMLElement, old: Inline[]): Inline[] {
  const out: Inline[] = [];
  for (const child of el.childNodes) {
    const text = child.textContent ?? '';
    const flag = child instanceof HTMLElement && child.dataset.flag !== undefined ? old[Number(child.dataset.flag)] : null;
    if (flag?.t === 'flag' && flag.text === text) out.push(flag);
    else out.push(...textToNodes(text));
  }
  return tidy(out);
}

function lastParaId(s: ReturnType<typeof useStore.getState>): string | undefined {
  return s.essays.find((e) => e.id === s.currentId)?.doc.paragraphs.at(-1)?.id;
}

function ParagraphBlock({ para, index, count, equationNo }: { para: Paragraph; index: number; count: number; equationNo?: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const [focused, setFocused] = useState(false);
  // Mathematics, headings and captions are drawn properly until the paragraph is clicked for editing.
  const rich = !focused && (kindOf(para.nodes) !== 'para' || para.nodes.some((node) => node.t === 'math'));
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const text = paraText(para);
  const docRev = useStore((s) => s.docRev);
  const focusN = useStore((s) => (s.focus?.paraId === para.id ? s.focus.n : 0));
  // Dictation goes to the paragraph last clicked in, otherwise the last one.
  const isTarget = useStore((s) => (s.activeParaId ?? lastParaId(s)) === para.id);
  const dictating = useDictation((s) => s.on && s.target === 'essay');
  const interim = useDictation((s) => (s.hearing || s.waiting > 0 ? s.interim || '…' : ''));
  const store = useStore.getState();
  const n = index + 1;

  // Show the stored text, without disturbing the caret while it already matches.
  useLayoutEffect(() => {
    const el = ref.current!;
    const flagCount = para.nodes.filter((node) => node.t === 'flag').length;
    if (el.textContent !== text || el.querySelectorAll('[data-flag]').length !== flagCount) drawNodes(el, para.nodes);
    el.dataset.empty = String(el.textContent === '');
  }, [text, docRev, para.nodes]);

  useEffect(() => {
    const focus = useStore.getState().focus;
    if (!focusN || !focus || !ref.current) return;
    ref.current.focus();
    setCaret(ref.current, focus.offset);
  }, [focusN]);

  function cancelTimer() {
    clearTimeout(timer.current);
    timer.current = undefined;
    clearPending(para.id);
  }

  function commit() {
    cancelTimer();
    const el = ref.current;
    if (el) useStore.getState().commitText(para.id, el.textContent ?? '', readNodes(el, para.nodes));
  }

  function onInput() {
    const el = ref.current!;
    el.dataset.empty = String(el.textContent === '');
    clearTimeout(timer.current);
    timer.current = setTimeout(commit, TYPING_SAVE_MS);
    registerPending(para.id, commit);
  }

  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    const el = ref.current!;
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      cancelTimer();
      store.split(para.id, el.textContent ?? '', caretOffset(el));
    } else if (e.key === 'Backspace' && index > 0 && window.getSelection()?.isCollapsed && caretOffset(el) === 0) {
      e.preventDefault();
      cancelTimer();
      store.merge(para.id, el.textContent ?? '');
    }
  }

  return (
    <div className="group relative flex gap-3" data-testid="paragraph">
      <div className="hidden w-8 shrink-0 select-none pt-1.5 text-right text-xs text-muted sm:block">P{n}</div>
      <div className="min-w-0 flex-1">
        <div
          ref={ref}
          role="textbox"
          aria-multiline="true"
          aria-label={`Paragraph ${n}`}
          contentEditable="plaintext-only"
          suppressContentEditableWarning
          spellCheck
          data-placeholder={count === 1 ? 'Start writing, or press Dictate and talk.' : ''}
          onInput={onInput}
          onFocus={() => {
            setFocused(true);
            store.setActivePara(para.id);
          }}
          onBlur={() => {
            setFocused(false);
            if (timer.current !== undefined) commit();
          }}
          onKeyDown={onKeyDown}
          onClick={(e) => {
            const flag = (e.target as HTMLElement).closest<HTMLElement>('[data-flag]');
            if (flag) store.flipFlag(para.id, Number(flag.dataset.flag));
          }}
          className={`whitespace-pre-wrap font-serif text-lg leading-relaxed ${rich ? 'pointer-events-none absolute h-0 overflow-hidden opacity-0' : 'min-h-7'}`}
        />
        {rich && <RichView nodes={para.nodes} equationNo={equationNo} onActivate={() => ref.current?.focus()} />}
        {dictating && isTarget && interim && (
          <p data-testid="interim" className="mt-1 font-serif text-lg italic leading-relaxed text-muted">
            {interim}
          </p>
        )}
      </div>
      <div className="hidden w-20 shrink-0 items-start gap-0.5 pt-1 opacity-0 focus-within:opacity-100 group-hover:opacity-100 md:flex">
        <IconButton label={`Move paragraph ${n} up`} disabled={index === 0} onClick={() => store.moveParagraph(para.id, -1)}>
          <ArrowUp size={14} />
        </IconButton>
        <IconButton label={`Move paragraph ${n} down`} disabled={index === count - 1} onClick={() => store.moveParagraph(para.id, 1)}>
          <ArrowDown size={14} />
        </IconButton>
        <IconButton label={`Delete paragraph ${n}`} onClick={() => store.deleteParagraph(para.id)}>
          <Trash2 size={14} />
        </IconButton>
      </div>
    </div>
  );
}

function DictationButton() {
  const { hearing, waiting, error, standby, awaiting } = useDictation();
  const listening = useDictation((s) => s.on && s.target === 'essay');
  // Talking with the counselor (the Jarvis button) and dictating (the Dictate button) are separate.
  const talking = useSettings((s) => s.counselorMode === 'conversation') && listening;
  const on = listening && !talking;
  const status =
    error ?? (standby ? 'Say “Jarvis”' : !listening ? '' : awaiting ? 'Yes? Go ahead…' : hearing ? 'Hearing you…' : waiting > 0 ? (talking ? 'Got that…' : 'Writing it down…') : talking ? 'Talking with Jarvis' : 'Listening');
  return (
    <>
      <button
        aria-pressed={talking}
        aria-label={talking ? 'Stop talking with Jarvis' : 'Talk with Jarvis'}
        title={talking ? 'You are talking with the counselor. Click to stop.' : 'Talk with the counselor out loud. Nothing you say goes into the essay.'}
        onClick={() => {
          if (!talking) useCounselor.getState().setOpen(true);
          void toggleConversation();
        }}
        className={`flex shrink-0 items-center gap-1 rounded-full border px-2.5 py-1.5 text-sm ${talking ? 'border-accent bg-accent-soft font-medium text-accent' : 'border-line text-muted'}`}
      >
        <Ear size={15} /> Jarvis
      </button>
      <span
        data-testid="dictation-status"
        role="status"
        title={status}
        className={`max-w-64 truncate text-sm ${error ? 'text-danger' : 'text-muted'}`}
      >
        {status}
      </span>
      <button
        aria-label={on ? 'Stop dictation' : 'Start dictation'}
        aria-pressed={on}
        onClick={() => toggleDictation('essay')}
        className={`flex shrink-0 items-center gap-1.5 rounded-full px-3 py-1.5 text-sm font-medium text-on-accent ${on ? 'bg-danger' : 'bg-accent'}`}
      >
        {on ? <MicOff size={16} /> : <Mic size={16} />}
        {on ? 'Stop' : 'Dictate'}
      </button>
    </>
  );
}

function IconButton(props: { label: string; onClick: () => void; disabled?: boolean; children: React.ReactNode }) {
  return (
    <button
      aria-label={props.label}
      title={props.label}
      disabled={props.disabled}
      onClick={props.onClick}
      className="rounded p-1 text-muted hover:bg-panel hover:text-ink"
    >
      {props.children}
    </button>
  );
}

export function Editor() {
  const essay = useStore((s) => s.essays.find((e) => e.id === s.currentId));
  const canUndo = useStore((s) => s.undoStack.length > 0);
  const canRedo = useStore((s) => s.redoStack.length > 0);
  const saveState = useStore((s) => s.saveState);
  const savedAt = useStore((s) => s.savedAt);
  const historyOpen = useStore((s) => s.historyOpen);
  const counselorOpen = useCounselor((s) => s.open);
  const store = useStore.getState();

  if (!essay) {
    return (
      <main className="flex flex-1 flex-col items-center justify-center gap-4 text-muted">
        <button onClick={() => useUi.getState().setNavOpen(true)} className="rounded-md border border-line px-3 py-2 text-sm md:hidden">
          Show essays
        </button>
        <p>Create an essay to start writing.</p>
        <button onClick={() => void store.createEssay()} className="rounded-md bg-accent px-3 py-2 font-medium text-on-accent">
          New essay
        </button>
      </main>
    );
  }

  // Equations on their own line are numbered in the order they appear.
  const equationNumbers = new Map<string, number>();
  for (const p of essay.doc.paragraphs) if (kindOf(p.nodes) === 'equation') equationNumbers.set(p.id, equationNumbers.size + 1);

  return (
    <main className="flex min-w-0 flex-1 flex-col">
      <header className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-line px-3 py-3 md:px-6">
        <button aria-label="Show essays" onClick={() => useUi.getState().setNavOpen(true)} className="rounded p-1 text-muted md:hidden">
          <Menu size={20} />
        </button>
        <input
          key={`${essay.id}:${essay.title}`}
          aria-label="Essay title"
          defaultValue={essay.title}
          onBlur={(e) => store.renameEssay(essay.id, e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
          className="min-w-0 flex-1 basis-40 bg-transparent font-serif text-2xl"
        />
        <DictationButton />
        <button
          aria-pressed={Boolean(essay.mathMode)}
          title="Math and physics mode: spoken mathematics is written as mathematics. It only writes down what you say."
          onClick={() => store.setMathMode(essay.id, !essay.mathMode)}
          className={`flex shrink-0 items-center gap-1 rounded-full border px-2.5 py-1.5 text-sm ${essay.mathMode ? 'border-accent bg-accent-soft font-medium text-accent' : 'border-line text-muted'}`}
        >
          <Sigma size={15} /> Math
        </button>
        <span className="flex shrink-0 items-center gap-1 text-sm text-muted">
          <span data-testid="word-count">
            {essay.wordCount} {essay.wordCount === 1 ? 'word' : 'words'}
          </span>
          <span aria-hidden="true">/</span>
          <input
            key={essay.id}
            aria-label="Word limit"
            title="Word limit for this essay"
            type="number"
            min={1}
            placeholder="limit"
            defaultValue={essay.wordLimit ?? ''}
            onBlur={(e) => store.setWordLimit(essay.id, e.target.value ? Number(e.target.value) : null)}
            onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
            className={`w-16 rounded border border-line bg-transparent px-1 py-0.5 text-right ${
              essay.wordLimit && essay.wordCount > essay.wordLimit ? 'text-danger' : ''
            }`}
          />
        </span>
        <span data-testid="save-state" aria-live="polite" className="w-28 shrink-0 text-right text-sm text-muted">
          {saveState === 'saving' ? 'Saving…' : savedAt ? `Saved ${clock(savedAt)}` : 'Saved'}
        </span>
        <IconButton label="Undo" disabled={!canUndo} onClick={() => store.undo()}>
          <Undo2 size={18} />
        </IconButton>
        <IconButton label="Redo" disabled={!canRedo} onClick={() => store.redo()}>
          <Redo2 size={18} />
        </IconButton>
        <IconButton label="Save a version" onClick={() => void store.saveVersion('Saved by you')}>
          <Save size={18} />
        </IconButton>
        <IconButton label="Version history" onClick={() => void store.openHistory(!historyOpen)}>
          <HistoryIcon size={18} />
        </IconButton>
        <IconButton label={counselorOpen ? 'Close counselor' : 'Open counselor'} onClick={() => useCounselor.getState().setOpen(!counselorOpen)}>
          <MessageCircle size={18} />
        </IconButton>
      </header>
      <SyncNote />
      <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2 border-b border-line px-3 py-2 md:px-6">
        <Stepper essay={essay} />
        <PromptPicker essay={essay} />
      </div>
      <div className="relative flex-1 overflow-y-auto px-4 pb-32 pt-6 md:px-6 md:py-10">
        <CommandChip />
        <div className="mx-auto max-w-3xl space-y-5">
          {essay.doc.paragraphs.map((p, i) => (
            <ParagraphBlock key={p.id} para={p} index={i} count={essay.doc.paragraphs.length} equationNo={equationNumbers.get(p.id)} />
          ))}
        </div>
      </div>
      <BigMic />
    </main>
  );
}

/** On a phone: one large button to start and stop dictating, for when the wake word is not in use. */
function BigMic() {
  const on = useDictation((s) => s.on && s.target === 'essay');
  const hearing = useDictation((s) => s.hearing);
  return (
    <button
      data-testid="big-mic"
      aria-label={on ? 'Stop dictating' : 'Dictate'}
      aria-pressed={on}
      onClick={() => toggleDictation('essay')}
      className={`fixed bottom-6 left-1/2 z-20 flex h-20 w-20 -translate-x-1/2 items-center justify-center rounded-full text-on-accent shadow-xl md:hidden ${on ? 'bg-danger' : 'bg-accent'} ${hearing ? 'ring-4 ring-danger/30' : ''}`}
    >
      {on ? <MicOff size={34} /> : <Mic size={34} />}
    </button>
  );
}

/** Shown only when it matters: the Mac is out of reach, or recordings are waiting for it. */
function SyncNote() {
  const { online, remote, queued } = useSync();
  if (queued === 0 && (online || !remote)) return null;
  const waiting = queued === 1 ? '1 recording is saved' : `${queued} recordings are saved`;
  return (
    <div data-testid="sync-note" role="status" className="border-b border-line bg-warn-soft px-3 py-1.5 text-sm md:px-6">
      {queued > 0
        ? `${online ? 'Connected' : 'Offline'}: ${waiting} on this device and will be transcribed ${online ? 'now' : 'when connected'}.`
        : 'Offline. You can keep dictating; recordings are saved on this device and transcribed when connected.'}
    </div>
  );
}
