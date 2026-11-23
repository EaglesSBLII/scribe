/**
 * Every change to an essay goes through an operation here.
 * Each operation is applied deterministically and returns its inverse,
 * which is what makes undo unlimited and exact.
 */
import { paraText, textToNodes, type Doc, type Inline, type Paragraph } from './types';
import { sentences, words } from './segment';

export type Op =
  | { k: 'insertParagraph'; index: number; para: Paragraph }
  | { k: 'deleteParagraph'; index: number }
  | { k: 'setParagraph'; index: number; nodes: Inline[] }
  | { k: 'moveParagraph'; from: number; to: number }
  | { k: 'replaceDoc'; doc: Doc }
  | { k: 'batch'; ops: Op[] };

export class OpError extends Error {}

/** Thrown when an operation would remove a lot of text and has not been confirmed. */
export class NeedsConfirmation extends Error {
  constructor(public removed: string[]) {
    super('This removes more than one sentence and needs confirmation.');
  }
}

function checkIndex(doc: Doc, index: number, allowEnd = false) {
  const max = allowEnd ? doc.paragraphs.length : doc.paragraphs.length - 1;
  if (!Number.isInteger(index) || index < 0 || index > max) {
    throw new OpError(`There is no paragraph ${index + 1}.`);
  }
}

function applyRaw(doc: Doc, op: Op): { doc: Doc; inverse: Op } {
  const ps = doc.paragraphs;
  switch (op.k) {
    case 'insertParagraph': {
      checkIndex(doc, op.index, true);
      const next = [...ps.slice(0, op.index), op.para, ...ps.slice(op.index)];
      return { doc: { paragraphs: next }, inverse: { k: 'deleteParagraph', index: op.index } };
    }
    case 'deleteParagraph': {
      checkIndex(doc, op.index);
      const next = ps.filter((_, i) => i !== op.index);
      return {
        doc: { paragraphs: next },
        inverse: { k: 'insertParagraph', index: op.index, para: ps[op.index] },
      };
    }
    case 'setParagraph': {
      checkIndex(doc, op.index);
      const old = ps[op.index];
      const next = ps.map((p, i) => (i === op.index ? { id: p.id, nodes: op.nodes } : p));
      return {
        doc: { paragraphs: next },
        inverse: { k: 'setParagraph', index: op.index, nodes: old.nodes },
      };
    }
    case 'moveParagraph': {
      checkIndex(doc, op.from);
      checkIndex(doc, op.to);
      const next = [...ps];
      const [moved] = next.splice(op.from, 1);
      next.splice(op.to, 0, moved);
      return { doc: { paragraphs: next }, inverse: { k: 'moveParagraph', from: op.to, to: op.from } };
    }
    case 'replaceDoc':
      return { doc: op.doc, inverse: { k: 'replaceDoc', doc } };
    case 'batch': {
      let cur = doc;
      const inverses: Op[] = [];
      for (const child of op.ops) {
        const r = applyRaw(cur, child);
        cur = r.doc;
        inverses.unshift(r.inverse);
      }
      return { doc: cur, inverse: { k: 'batch', ops: inverses } };
    }
  }
}

/** Items of `a` that are not matched one-for-one by an item of `b`. */
function multisetMinus(a: string[], b: string[]): string[] {
  const left = new Map<string, number>();
  for (const x of b) left.set(x, (left.get(x) ?? 0) + 1);
  const out: string[] = [];
  for (const x of a) {
    const n = left.get(x) ?? 0;
    if (n > 0) left.set(x, n - 1);
    else out.push(x);
  }
  return out;
}

const allSentences = (doc: Doc) => doc.paragraphs.flatMap((p) => sentences(paraText(p)).map((s) => s.text));
const allWords = (doc: Doc) => doc.paragraphs.flatMap((p) => words(paraText(p)));

export interface DeletionImpact {
  /** True when the change needs an explicit confirmation. */
  large: boolean;
  /** Exactly what would be removed, for the confirmation dialog. */
  removed: string[];
}

/**
 * Measures what a change removes. Removing more than one sentence, or a whole
 * non-empty paragraph, is "large". Moving or re-joining text removes nothing.
 */
export function deletionImpact(before: Doc, after: Doc): DeletionImpact {
  if (multisetMinus(allWords(before), allWords(after)).length === 0) {
    return { large: false, removed: [] };
  }
  const removed = multisetMinus(allSentences(before), allSentences(after));
  const added = multisetMinus(allSentences(after), allSentences(before));
  const afterIds = new Set(after.paragraphs.map((p) => p.id));
  const lostParagraph = before.paragraphs.some((p) => {
    if (afterIds.has(p.id)) return false;
    const own = sentences(paraText(p)).map((s) => s.text);
    return own.length > 0 && multisetMinus(own, removed).length === 0;
  });
  return { large: lostParagraph || removed.length - added.length >= 2, removed };
}

/**
 * Apply an operation. A large deletion throws NeedsConfirmation unless
 * `confirmed` is true; only the confirmation dialog passes true.
 */
export function applyOp(doc: Doc, op: Op, confirmed = false): { doc: Doc; inverse: Op } {
  const result = applyRaw(doc, op);
  if (result.doc.paragraphs.length === 0) throw new OpError('An essay keeps at least one paragraph.');
  if (!confirmed) {
    const impact = deletionImpact(doc, result.doc);
    if (impact.large) throw new NeedsConfirmation(impact.removed);
  }
  return result;
}

// ---- Builders for the edits the editor makes ----

export function setText(index: number, text: string): Op {
  return { k: 'setParagraph', index, nodes: textToNodes(text) };
}

/** Split one paragraph in two at a character offset. */
export function splitParagraph(index: number, text: string, offset: number, newPara: Paragraph): Op {
  return {
    k: 'batch',
    ops: [
      setText(index, text.slice(0, offset).trimEnd()),
      { k: 'insertParagraph', index: index + 1, para: { ...newPara, nodes: textToNodes(text.slice(offset).trimStart()) } },
    ],
  };
}

/** Join a paragraph onto the end of the one before it. Removes no words. */
export function mergeWithPrevious(doc: Doc, index: number, currentText: string): { op: Op; caret: number } {
  const prev = paraText(doc.paragraphs[index - 1]);
  const glue = prev && currentText && !/\s$/.test(prev) ? ' ' : '';
  return {
    op: { k: 'batch', ops: [setText(index - 1, prev + glue + currentText), { k: 'deleteParagraph', index }] },
    caret: prev.length + glue.length,
  };
}

/** Join neighbouring text nodes and drop empty ones. */
export function tidy(nodes: Inline[]): Inline[] {
  const out: Inline[] = [];
  for (const n of nodes) {
    const last = out.at(-1);
    if (n.t === 'text' && !n.text) continue;
    if (n.t === 'text' && last?.t === 'text') out[out.length - 1] = { t: 'text', text: last.text + n.text };
    else out.push(n);
  }
  return out;
}

/**
 * Switch a flagged word to its other reading ("." <-> " period") and fix the
 * capital on the word that follows.
 */
export function flipFlag(doc: Doc, index: number, nodeIndex: number): Op | null {
  const nodes = doc.paragraphs[index]?.nodes;
  const flag = nodes?.[nodeIndex];
  if (!nodes || flag?.t !== 'flag') return null;
  const next = [...nodes];
  const flipped: Inline = { t: 'flag', text: flag.alt, alt: flag.text };
  const after = next[nodeIndex + 1];
  if (after?.t === 'text') {
    if (/[.?!]$/.test(flag.alt) && /^\s*\p{Ll}/u.test(after.text)) {
      next[nodeIndex + 1] = { t: 'text', text: after.text.replace(/\p{Ll}/u, (c) => c.toUpperCase()) };
      flipped.cap = true;
    } else if (flag.cap) {
      next[nodeIndex + 1] = { t: 'text', text: after.text.replace(/\p{Lu}/u, (c) => c.toLowerCase()) };
    }
  }
  next[nodeIndex] = flipped;
  return { k: 'setParagraph', index, nodes: next };
}

type DictatedPiece = Inline | { t: 'break' };

/**
 * Add dictated text to the end of a paragraph. A break starts a new paragraph
 * after it. Returns the index of the paragraph dictation should continue in.
 */
export function appendPieces(doc: Doc, index: number, pieces: DictatedPiece[], newPara: () => Paragraph): { op: Op; lastIndex: number } | null {
  const groups: Inline[][] = [[]];
  for (const p of pieces) {
    if (p.t === 'break') groups.push([]);
    else groups.at(-1)!.push(p);
  }
  if (pieces.length === 0) return null;
  const existing = doc.paragraphs[index];
  const text = paraText(existing);
  const first = groups[0];
  const ops: Op[] = [];
  if (first.length) {
    const glue: Inline[] = text && !/\s$/.test(text) ? [{ t: 'text', text: ' ' }] : [];
    ops.push({ k: 'setParagraph', index, nodes: tidy([...existing.nodes, ...glue, ...first]) });
  } else if (groups.length > 1 && text.trim() && !/[.?!]["”')\]]*$/.test(text.trimEnd())) {
    // "New paragraph" said on its own closes the sentence before it.
    ops.push({ k: 'setParagraph', index, nodes: tidy([...existing.nodes, { t: 'text', text: '.' }]) });
  }
  let at = index;
  for (const group of groups.slice(1)) {
    // Do not stack empty paragraphs when the current one is still empty.
    if (at === index && !text.trim() && !first.length) {
      if (group.length) ops.push({ k: 'setParagraph', index, nodes: tidy(group) });
      continue;
    }
    at++;
    ops.push({ k: 'insertParagraph', index: at, para: { ...newPara(), nodes: tidy(group) } });
  }
  if (ops.length === 0) return null;
  return { op: ops.length === 1 ? ops[0] : { k: 'batch', ops }, lastIndex: at };
}
