/**
 * One store for the whole app, as in Chilaka: state is loaded from Dexie at
 * start and every action writes straight back, so there is no "unsaved" state.
 */
import { create } from 'zustand';
import { db, type AccountRow, type EssayRow, type OpRow, type Stage, type VersionRow } from './db/schema';
import { createAccount, currentAccount } from './account';
import {
  appendPieces, applyOp, deletionImpact, flipFlag, mergeWithPrevious, NeedsConfirmation, OpError, setText,
  splitParagraph, type Op,
} from './doc/ops';
import { docText, emptyDoc, emptyParagraph, paraText, type Doc, type Inline } from './doc/types';
import { clean, guard, type HeardWord } from './dictation/clean';
import { classifySpokenWord, looksLikeEditRequest, restateCommand } from './llm/assist';
import { useCounselor } from './llm/counselor';
import { useSettings } from './settings';
import { useMemory } from './memory/store';
import { readPaperUtterance } from './math/paper';
import { usePaper } from './paper/store';
import { applySeed } from './colleges/seed';
import { useColleges } from './colleges/store';
import { parseCommand, type Command } from './commands/parse';
import { resolve } from './commands/run';
import { speak, stopSpeaking } from './speech';
import { countWords } from './doc/segment';
import { flushPending } from './editorBus';

export interface ConfirmRequest {
  title: string;
  body: string;
  /** Exactly what will be removed. */
  items: string[];
  confirmLabel: string;
  onConfirm: () => void | Promise<void>;
  onCancel?: () => void;
}

export interface Toast {
  text: string;
  actionLabel?: string;
  action?: () => void | Promise<void>;
}

interface FocusRequest {
  paraId: string;
  offset: number;
  n: number;
}

/** What a voice command is doing, shown above the essay. */
export interface CommandChip {
  text: string;
  phase: 'pending' | 'done' | 'info' | 'error';
  /** The one-tap button the chip offers. */
  action?: 'cancel' | 'undo' | 'stop';
}

const AUTO_VERSION_MS = 10 * 60 * 1000;
/** How long a parsed edit is shown before it is applied. */
const PREVIEW_MS = 1200;

interface State {
  ready: boolean;
  account: AccountRow | null;
  essays: EssayRow[];
  currentId: string | null;
  undoStack: OpRow[];
  redoStack: OpRow[];
  saveState: 'saved' | 'saving';
  savedAt: number | null;
  /** Bumped whenever the document changes other than by typing, so the editor redraws. */
  docRev: number;
  focus: FocusRequest | null;
  confirm: ConfirmRequest | null;
  toast: Toast | null;
  versions: VersionRow[];
  historyOpen: boolean;
  /** The paragraph dictation adds to: the one last clicked in, else the last one. */
  activeParaId: string | null;
  chip: CommandChip | null;

  setWordLimit(id: string, limit: number | null): void;
  /** Returns false when the words should be treated as dictation after all. */
  handleCommand(cmd: Command): boolean;
  /** Apply a previewed command now instead of waiting out the preview. */
  flushCommand(): void;
  chipAction(): void;
  clearChip(): void;

  init(): Promise<void>;
  signUp(email: string): Promise<void>;
  createEssay(): Promise<void>;
  openEssay(id: string): Promise<void>;
  renameEssay(id: string, title: string): void;
  setArchived(id: string, archived: boolean): void;
  moveEssay(id: string, toIndex: number): void;
  requestDeleteEssay(id: string): void;

  edit(op: Op, opts?: { confirmed?: boolean; ask?: string[]; focus?: { paraId: string; offset: number } }): boolean;
  /** `nodes` carries any flagged words that are still intact in the editor. */
  commitText(paraId: string, text: string, nodes?: Inline[]): void;
  setActivePara(paraId: string): void;
  flipFlag(paraId: string, nodeIndex: number): void;
  /** Clean what Whisper heard and add it where dictation is pointing. */
  insertHeard(words: HeardWord[], paused: boolean): Promise<void>;
  setStage(id: string, stage: Stage): void;
  setPromptText(id: string, text: string): void;
  /** Math and physics mode: spoken mathematics is written as mathematics. */
  setMathMode(id: string, on: boolean): void;
  /** The learned paper format this essay is exported in, or null for the default. */
  setFormat(id: string, formatId: string | null): void;
  /** Tie the essay to a college and one of its prompts. */
  setEssayPrompt(id: string, collegeId: string | null, promptId: string | null): void;
  split(paraId: string, text: string, offset: number): void;
  merge(paraId: string, text: string): void;
  deleteParagraph(paraId: string): void;
  moveParagraph(paraId: string, delta: number): void;
  undo(): void;
  redo(): void;

  saveVersion(reason: string): Promise<void>;
  openHistory(open: boolean): Promise<void>;
  restoreVersion(v: VersionRow): void;

  closeConfirm(confirmed: boolean): Promise<void>;
  setToast(t: Toast | null): void;
}

// Writes are queued so they reach the database in the order they happened.
let queue: Promise<unknown> = Promise.resolve();
let lastVersionAt = 0;
let previewTimer: ReturnType<typeof setTimeout> | undefined;
let previewed: Command | null = null;

export const useStore = create<State>((set, get) => {
  function persist(work: () => Promise<unknown>) {
    set({ saveState: 'saving' });
    const mine = (queue = queue.then(work).catch((err) => {
      console.error('Scribe could not save', err);
      set({ toast: { text: 'Saving failed. Your last change may not be stored.' } });
    }));
    void mine.then(() => {
      if (queue === mine) set({ saveState: 'saved', savedAt: Date.now() });
    });
  }

  const current = () => get().essays.find((e) => e.id === get().currentId) ?? null;

  function patchEssay(id: string, patch: Partial<EssayRow>) {
    const essays = get().essays.map((e) => (e.id === id ? { ...e, ...patch } : e));
    set({ essays });
    const row = essays.find((e) => e.id === id);
    if (row) persist(() => db.essays.put(row));
  }

  /** Put a new document on the current essay and return the row to store. */
  function withDoc(essay: EssayRow, doc: Doc): EssayRow {
    const next = { ...essay, doc, wordCount: countWords(docText(doc)), updatedAt: Date.now() };
    set({ essays: get().essays.map((e) => (e.id === essay.id ? next : e)) });
    return next;
  }

  function addVersion(essay: EssayRow, reason: string) {
    const row: VersionRow = {
      essayId: essay.id, ts: Date.now(), reason, wordCount: essay.wordCount, doc: essay.doc,
    };
    lastVersionAt = row.ts;
    persist(async () => {
      await db.versions.add(row);
      if (get().historyOpen && get().currentId === essay.id) {
        set({ versions: await db.versions.where('essayId').equals(essay.id).reverse().sortBy('ts') });
      }
    });
  }

  return {
    ready: false,
    account: null,
    essays: [],
    currentId: null,
    undoStack: [],
    redoStack: [],
    saveState: 'saved',
    savedAt: null,
    docRev: 0,
    focus: null,
    confirm: null,
    toast: null,
    versions: [],
    historyOpen: false,
    activeParaId: null,
    chip: null,

    setWordLimit(id, limit) {
      patchEssay(id, { wordLimit: limit && limit > 0 ? Math.round(limit) : null });
    },

    handleCommand(cmd) {
      get().flushCommand();
      const essay = current();
      if (!essay) return false;
      const context = () => {
        const now = current()!;
        const active = now.doc.paragraphs.findIndex((p) => p.id === get().activeParaId);
        return { activeIndex: active < 0 ? now.doc.paragraphs.length - 1 : active, wordLimit: now.wordLimit ?? null };
      };
      const out = resolve(cmd, essay.doc, context());
      switch (out.k) {
        case 'error':
          // "Change came to my town" is a sentence, not a failed replace.
          if (out.notFound) return false;
          set({ chip: { text: out.text, phase: 'error' } });
          return true;
        case 'say':
          set({ chip: out.read ? { text: 'Reading aloud', phase: 'info', action: 'stop' } : { text: out.text, phase: 'info' } });
          speak(out.text);
          return true;
        case 'undo':
        case 'redo': {
          const stack = out.k === 'undo' ? get().undoStack : get().redoStack;
          if (stack.length === 0) {
            set({ chip: { text: `Nothing to ${out.k}.`, phase: 'error' } });
          } else {
            if (out.k === 'undo') get().undo();
            else get().redo();
            set({ chip: { text: out.k === 'undo' ? 'Undid the last change' : 'Redid the change', phase: 'done' } });
          }
          return true;
        }
        case 'edit':
          // Show what is about to happen, then do it.
          previewed = cmd;
          set({ chip: { text: out.label, phase: 'pending', action: 'cancel' } });
          previewTimer = setTimeout(() => get().flushCommand(), PREVIEW_MS);
          return true;
      }
    },

    flushCommand() {
      clearTimeout(previewTimer);
      const cmd = previewed;
      previewed = null;
      const essay = current();
      if (!cmd || !essay) return;
      const active = essay.doc.paragraphs.findIndex((p) => p.id === get().activeParaId);
      // Worked out again against the essay as it is now.
      const out = resolve(cmd, essay.doc, {
        activeIndex: active < 0 ? essay.doc.paragraphs.length - 1 : active,
        wordLimit: essay.wordLimit ?? null,
      });
      if (out.k !== 'edit') return set({ chip: out.k === 'error' ? { text: out.text, phase: 'error' } : null });
      // A large deletion stops at the confirmation dialog like any other.
      const applied = get().edit(out.op);
      set({ chip: applied ? { text: out.done, phase: 'done', action: 'undo' } : null });
    },

    chipAction() {
      const chip = get().chip;
      if (chip?.action === 'cancel') {
        clearTimeout(previewTimer);
        previewed = null;
      } else if (chip?.action === 'undo') {
        get().undo();
      } else if (chip?.action === 'stop') {
        stopSpeaking();
      }
      set({ chip: null });
    },

    clearChip() {
      if (get().chip?.phase !== 'pending') set({ chip: null });
    },

    async init() {
      const account = await currentAccount();
      if (!account) return set({ ready: true });
      await useSettings.getState().load(account.id);
      await useMemory.getState().load(account.id);
      await usePaper.getState().load(account.id);
      await applySeed();
      await useColleges.getState().load();
      // The essays are read last and shown at once. Reading them before the slower
      // steps above let a just-created essay be replaced by an out-of-date list.
      const essays = await db.essays.where('accountId').equals(account.id).sortBy('order');
      set({ account, essays, ready: true });
      const last = await db.settings.get([account.id, 'lastEssayId']);
      const open = essays.find((e) => e.id === last?.value && !e.archived) ?? essays.find((e) => !e.archived);
      if (open) await get().openEssay(open.id);
    },

    async signUp(email) {
      await createAccount(email);
      // The app appears only once everything is loaded, so nothing can be created mid-load.
      await get().init();
    },

    async createEssay() {
      const { account, essays } = get();
      if (!account) return;
      flushPending();
      const now = Date.now();
      const row: EssayRow = {
        id: crypto.randomUUID(), accountId: account.id, title: 'Untitled essay',
        collegeId: null, promptId: null, stage: 'draft',
        order: essays.reduce((m, e) => Math.max(m, e.order), -1) + 1,
        archived: false, wordCount: 0, createdAt: now, updatedAt: now, doc: emptyDoc(),
      };
      set({ essays: [...essays, row] });
      persist(() => db.essays.add(row));
      await get().openEssay(row.id);
    },

    async openEssay(id) {
      const account = get().account;
      if (!account) return;
      flushPending();
      await queue;
      const rows = await db.ops.where('essayId').equals(id).sortBy('seq');
      const lastVersion = await db.versions.where('essayId').equals(id).last();
      lastVersionAt = lastVersion?.ts ?? Date.now();
      set({
        currentId: id,
        undoStack: rows.filter((r) => !r.undone),
        // Undo walks backwards, so the edit to redo first is the earliest undone one.
        redoStack: rows.filter((r) => r.undone).reverse(),
        docRev: get().docRev + 1,
        historyOpen: false,
        versions: [],
        activeParaId: null,
      });
      persist(() => db.settings.put({ accountId: account.id, key: 'lastEssayId', value: id }));
      void useCounselor.getState().load(id);
    },

    renameEssay(id, title) {
      const clean = title.trim();
      if (clean) patchEssay(id, { title: clean });
    },

    setArchived(id, archived) {
      flushPending();
      patchEssay(id, { archived });
      if (archived && get().currentId === id) {
        const next = get().essays.find((e) => !e.archived);
        if (next) void get().openEssay(next.id);
        else set({ currentId: null });
      }
    },

    moveEssay(id, toIndex) {
      const list = [...get().essays].sort((a, b) => a.order - b.order);
      const from = list.findIndex((e) => e.id === id);
      if (from < 0 || toIndex < 0 || toIndex >= list.length || from === toIndex) return;
      const [moved] = list.splice(from, 1);
      list.splice(toIndex, 0, moved);
      const essays = list.map((e, order) => ({ ...e, order }));
      set({ essays });
      persist(() => db.essays.bulkPut(essays));
    },

    requestDeleteEssay(id) {
      flushPending();
      const essay = get().essays.find((e) => e.id === id);
      if (!essay) return;
      const text = docText(essay.doc).trim();
      set({
        confirm: {
          title: `Delete "${essay.title}"?`,
          body: `This removes the whole essay (${essay.wordCount} words), its undo history and its saved versions.`,
          items: text ? [text] : [],
          confirmLabel: 'Delete essay',
          onConfirm: async () => {
            await queue;
            const ops = await db.ops.where('essayId').equals(id).toArray();
            const versions = await db.versions.where('essayId').equals(id).toArray();
            const wasCurrent = get().currentId === id;
            set({ essays: get().essays.filter((e) => e.id !== id) });
            if (wasCurrent) {
              const next = get().essays.find((e) => !e.archived);
              if (next) await get().openEssay(next.id);
              else set({ currentId: null, undoStack: [], redoStack: [] });
            }
            persist(() =>
              db.transaction('rw', db.essays, db.ops, db.versions, async () => {
                await db.essays.delete(id);
                await db.ops.where('essayId').equals(id).delete();
                await db.versions.where('essayId').equals(id).delete();
              }),
            );
            set({
              toast: {
                text: `Deleted "${essay.title}".`,
                actionLabel: 'Undo',
                action: async () => {
                  set({ essays: [...get().essays, essay].sort((a, b) => a.order - b.order) });
                  persist(() =>
                    db.transaction('rw', db.essays, db.ops, db.versions, async () => {
                      await db.essays.put(essay);
                      await db.ops.bulkPut(ops);
                      await db.versions.bulkPut(versions);
                    }),
                  );
                  await get().openEssay(essay.id);
                },
              },
            });
          },
        },
      });
    },

    edit(op, opts = {}) {
      const essay = current();
      if (!essay) return false;
      let result: { doc: Doc; inverse: Op };
      try {
        if (opts.ask && !opts.confirmed) throw new NeedsConfirmation(opts.ask);
        result = applyOp(essay.doc, op, opts.confirmed);
      } catch (err) {
        if (err instanceof NeedsConfirmation) {
          set({
            confirm: {
              title: 'Delete this text?',
              body: 'This will be removed from your essay. You can undo it afterwards.',
              items: err.removed,
              confirmLabel: 'Delete',
              onConfirm: () => {
                const now = current();
                if (now) addVersion(now, 'Before a large deletion');
                get().edit(op, { ...opts, confirmed: true });
              },
              // Put back whatever the editor is showing.
              onCancel: () => set({ docRev: get().docRev + 1 }),
            },
          });
          return false;
        }
        if (err instanceof OpError) {
          set({ toast: { text: err.message } });
          return false;
        }
        throw err;
      }

      const row: OpRow = { essayId: essay.id, ts: Date.now(), op, inverse: result.inverse, undone: false };
      const dropped = get().redoStack;
      const saved = withDoc(essay, result.doc);
      set({
        undoStack: [...get().undoStack, row],
        redoStack: [],
        docRev: get().docRev + 1,
        focus: opts.focus ? { ...opts.focus, n: (get().focus?.n ?? 0) + 1 } : get().focus,
      });
      persist(() =>
        db.transaction('rw', db.essays, db.ops, async () => {
          await db.essays.put(saved);
          // A new edit discards anything that was waiting to be redone.
          await db.ops.bulkDelete(dropped.map((r) => r.seq!).filter((s) => s !== undefined));
          row.seq = await db.ops.add(row);
        }),
      );
      if (saved.wordCount > 0 && Date.now() - lastVersionAt > AUTO_VERSION_MS) addVersion(saved, 'Automatic');
      return true;
    },

    commitText(paraId, text, nodes) {
      const essay = current();
      if (!essay) return;
      const index = essay.doc.paragraphs.findIndex((p) => p.id === paraId);
      if (index < 0) return;
      const parts = text.split(/\n+/);
      if (parts.length === 1) {
        if (text === paraText(essay.doc.paragraphs[index])) return;
        get().edit(nodes ? { k: 'setParagraph', index, nodes } : setText(index, text));
        return;
      }
      // Pasted text with line breaks becomes separate paragraphs.
      const extra = parts.slice(1).filter((t) => t.trim());
      get().edit({
        k: 'batch',
        ops: [
          setText(index, parts[0]),
          ...extra.map((t, i): Op => ({
            k: 'insertParagraph', index: index + 1 + i, para: { ...emptyParagraph(), nodes: [{ t: 'text', text: t.trim() }] },
          })),
        ],
      });
    },

    setActivePara(paraId) {
      if (get().activeParaId !== paraId) set({ activeParaId: paraId });
    },

    flipFlag(paraId, nodeIndex) {
      flushPending();
      const essay = current();
      if (!essay) return;
      const index = essay.doc.paragraphs.findIndex((p) => p.id === paraId);
      const op = index < 0 ? null : flipFlag(essay.doc, index, nodeIndex);
      if (op) get().edit(op);
    },

    async insertHeard(heard, paused) {
      flushPending();
      // An edit still being previewed is applied first, so everything stays in spoken order.
      get().flushCommand();
      // A whole utterance that fits the command grammar is a command, not essay text.
      let cmd = paused ? parseCommand(heard) : null;
      const said = heard.map((h) => h.text).join(' ').replace(/\s+/g, ' ').trim();
      if (!cmd && paused && looksLikeEditRequest(said)) {
        // It sounds like an edit request in other words: ask the local model to
        // restate it in the fixed grammar, then check that restatement in code.
        set({ chip: { text: 'Working out that request…', phase: 'info' } });
        const restated = await restateCommand(said);
        set({ chip: null });
        const parsed = restated ? parseCommand(restated) : null;
        const onlySpokenWords =
          !parsed ||
          (parsed.k === 'insert' && guard(said, parsed.words.map((w) => w.text).join(' '))) ||
          (parsed.k === 'replace' && guard(said, parsed.find) && guard(said, parsed.with)) ||
          (parsed.k !== 'insert' && parsed.k !== 'replace');
        if (parsed && onlySpokenWords) cmd = parsed;
      }
      if (cmd && get().handleCommand(cmd)) return;
      const essay = current();
      if (!essay) return;
      const ps = essay.doc.paragraphs;
      let index = ps.findIndex((p) => p.id === get().activeParaId);
      if (index < 0) index = ps.length - 1;
      const before = paraText(ps[index]).trimEnd();
      const continuing = before !== '' && !/[.?!]["”')\]]*$/.test(before);
      // In math mode, spoken mathematics, headings, captions and equations are set as such.
      const paper = essay.mathMode ? readPaperUtterance(heard, paused, continuing) : null;
      if (paper?.k === 'block') {
        // A heading, caption or equation gets its own paragraph, and dictation carries on in a fresh one after it.
        const next = emptyParagraph();
        const ops: Op[] = before === ''
          ? [{ k: 'setParagraph', index, nodes: paper.nodes }, { k: 'insertParagraph', index: index + 1, para: next }]
          : [{ k: 'insertParagraph', index: index + 1, para: { ...emptyParagraph(), nodes: paper.nodes } }, { k: 'insertParagraph', index: index + 2, para: next }];
        if (get().edit({ k: 'batch', ops })) set({ activeParaId: next.id });
        return;
      }
      const pieces = paper?.k === 'inline' ? paper.pieces : clean(heard, { final: paused, continuing }).pieces;
      const result = appendPieces(essay.doc, index, pieces, emptyParagraph);
      if (!result) return;
      // Adding text never removes any, so this cannot trip the deletion guard.
      if (get().edit(result.op)) {
        const now = current();
        set({ activeParaId: now?.doc.paragraphs[result.lastIndex]?.id ?? null });
      }
      // For each word the rules were unsure about, get the local model's opinion.
      // It can only switch the highlight to the other reading; the highlight stays.
      for (const piece of pieces) {
        if (piece.t !== 'flag') continue;
        const readAsWord = /\p{L}/u.test(piece.text);
        void classifySpokenWord(said, (readAsWord ? piece.text : piece.alt).trim()).then((answer) => {
          if (!answer || (answer === 'word') === readAsWord) return;
          for (const p of current()?.doc.paragraphs ?? []) {
            const at = p.nodes.indexOf(piece);
            if (at >= 0) return get().flipFlag(p.id, at);
          }
        });
      }
    },

    setStage(id, stage) {
      flushPending();
      const essay = get().essays.find((e) => e.id === id);
      if (!essay || essay.stage === stage) return;
      if (essay.wordCount > 0) addVersion(essay, `Moved to ${stage[0].toUpperCase()}${stage.slice(1)}`);
      patchEssay(id, { stage });
    },

    setPromptText(id, text) {
      patchEssay(id, { promptText: text.trim() });
    },

    setMathMode(id, on) {
      patchEssay(id, { mathMode: on });
    },

    setFormat(id, formatId) {
      patchEssay(id, { formatId });
    },

    setEssayPrompt(id, collegeId, promptId) {
      const essay = get().essays.find((e) => e.id === id);
      if (!essay) return;
      const { colleges, prompts } = useColleges.getState();
      const college = colleges.find((c) => c.id === collegeId);
      const prompt = prompts.find((p) => p.id === promptId);
      const patch: Partial<EssayRow> = { collegeId: college?.id ?? null, promptId: prompt?.id ?? null };
      if (prompt) {
        // The prompt's text and limit are copied onto the essay, so later edits
        // to the database do not silently change an essay in progress.
        patch.promptText = prompt.text;
        patch.wordLimit = prompt.wordLimit ?? essay.wordLimit ?? null;
        if (college && /^Untitled essay$/.test(essay.title)) patch.title = `${college.name}: ${prompt.label}`;
      }
      patchEssay(id, patch);
    },

    split(paraId, text, offset) {
      const essay = current();
      if (!essay) return;
      const index = essay.doc.paragraphs.findIndex((p) => p.id === paraId);
      if (index < 0) return;
      const para = emptyParagraph();
      get().edit(splitParagraph(index, text, offset, para), { focus: { paraId: para.id, offset: 0 } });
    },

    merge(paraId, text) {
      const essay = current();
      if (!essay) return;
      const index = essay.doc.paragraphs.findIndex((p) => p.id === paraId);
      if (index < 1) return;
      const { op, caret } = mergeWithPrevious(essay.doc, index, text);
      get().edit(op, { focus: { paraId: essay.doc.paragraphs[index - 1].id, offset: caret } });
    },

    deleteParagraph(paraId) {
      flushPending();
      const essay = current();
      if (!essay) return;
      const index = essay.doc.paragraphs.findIndex((p) => p.id === paraId);
      if (index < 0) return;
      const text = paraText(essay.doc.paragraphs[index]).trim();
      const only = essay.doc.paragraphs.length === 1;
      // Removing a paragraph that has text always asks first.
      get().edit(only ? setText(0, '') : { k: 'deleteParagraph', index }, text ? { ask: [text] } : {});
    },

    moveParagraph(paraId, delta) {
      flushPending();
      const essay = current();
      if (!essay) return;
      const from = essay.doc.paragraphs.findIndex((p) => p.id === paraId);
      const to = from + delta;
      if (from < 0 || to < 0 || to >= essay.doc.paragraphs.length) return;
      get().edit({ k: 'moveParagraph', from, to });
    },

    undo() {
      flushPending();
      const essay = current();
      const row = get().undoStack.at(-1);
      if (!essay || !row) return;
      // Undo is itself an explicit request and can be redone, so it does not ask again.
      const saved = withDoc(essay, applyOp(essay.doc, row.inverse, true).doc);
      row.undone = true;
      set({
        undoStack: get().undoStack.slice(0, -1),
        redoStack: [...get().redoStack, row],
        docRev: get().docRev + 1,
      });
      persist(() =>
        db.transaction('rw', db.essays, db.ops, async () => {
          await db.essays.put(saved);
          await db.ops.update(row.seq!, { undone: true });
        }),
      );
    },

    redo() {
      flushPending();
      const essay = current();
      const row = get().redoStack.at(-1);
      if (!essay || !row) return;
      const saved = withDoc(essay, applyOp(essay.doc, row.op, true).doc);
      row.undone = false;
      set({
        redoStack: get().redoStack.slice(0, -1),
        undoStack: [...get().undoStack, row],
        docRev: get().docRev + 1,
      });
      persist(() =>
        db.transaction('rw', db.essays, db.ops, async () => {
          await db.essays.put(saved);
          await db.ops.update(row.seq!, { undone: false });
        }),
      );
    },

    async saveVersion(reason) {
      flushPending();
      const essay = current();
      if (!essay) return;
      addVersion(essay, reason);
      set({ toast: { text: 'Version saved.' } });
    },

    async openHistory(open) {
      flushPending();
      const id = get().currentId;
      if (!open || !id) return set({ historyOpen: false });
      await queue;
      set({ historyOpen: true, versions: await db.versions.where('essayId').equals(id).reverse().sortBy('ts') });
    },

    restoreVersion(v) {
      flushPending();
      const essay = current();
      if (!essay) return;
      const removed = deletionImpact(essay.doc, v.doc).removed;
      set({
        confirm: {
          title: 'Restore this version?',
          body: 'Your current text is saved as a version first, and you can undo the restore. Restoring removes:',
          items: removed.length ? removed : ['Nothing: every current sentence is also in that version.'],
          confirmLabel: 'Restore version',
          onConfirm: () => {
            const now = current();
            if (!now) return;
            addVersion(now, 'Before restoring an older version');
            get().edit({ k: 'replaceDoc', doc: v.doc }, { confirmed: true });
          },
        },
      });
    },

    async closeConfirm(confirmed) {
      const request = get().confirm;
      set({ confirm: null });
      if (!request) return;
      if (confirmed) await request.onConfirm();
      else request.onCancel?.();
    },

    setToast(toast) {
      set({ toast });
    },
  };
});
