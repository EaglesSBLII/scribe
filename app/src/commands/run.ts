/**
 * Works out exactly what a parsed command does to a given document.
 * Pure and deterministic: the same command on the same document always
 * gives the same operation. Word counts are computed here, never estimated.
 */
import type { Command, ParaRef, SentRef } from './parse';
import { clean } from '../dictation/clean';
import { tidy, type Op } from '../doc/ops';
import { countWords, sentences, type Sentence } from '../doc/segment';
import { docText, nodeText, paraText, type Doc, type Inline } from '../doc/types';

export interface CommandContext {
  /** Index of the paragraph dictation is pointing at. */
  activeIndex: number;
  wordLimit: number | null;
  /** Set when the writer has gone back to an earlier sentence: new text goes after it. */
  cursor?: { index: number; sentence: number } | null;
}

/** One way to answer a clarifying question. `say` are the words that choose it. */
export interface Choice {
  say: string[];
  cmd: Command;
}

export type Outcome =
  /** `label` is shown before it applies ("Inserting after P3·S1"); `done` after. */
  | { k: 'edit'; op: Op; label: string; done: string }
  /** Something to show and speak; `read` marks essay text being read back. */
  | { k: 'say'; text: string; read?: boolean }
  | { k: 'undo' }
  | { k: 'redo' }
  /** The request could mean two things. Scribe asks; it never guesses on a deletion. */
  | { k: 'ask'; question: string; choices: Choice[] }
  /** Needs things only the app knows (the utterance log, the model, settings). */
  | { k: 'app' }
  | { k: 'error'; text: string; notFound?: boolean };

const err = (text: string): Outcome => ({ k: 'error', text });
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

function nodeLength(n: Inline): number {
  return nodeText(n).length;
}

/** The nodes covering characters [from, to) of the paragraph's text. */
export function sliceNodes(nodes: Inline[], from: number, to: number): Inline[] {
  const out: Inline[] = [];
  let at = 0;
  for (const n of nodes) {
    const end = at + nodeLength(n);
    if (end > from && at < to) {
      if (n.t === 'text') out.push({ t: 'text', text: n.text.slice(Math.max(0, from - at), to - at) });
      // Math and flagged words are never cut in half.
      else if (at >= from && end <= to) out.push(n);
    }
    at = end;
  }
  return out;
}

function paraIndex(doc: Doc, ref: ParaRef | undefined, ctx: CommandContext): number | Outcome {
  const count = doc.paragraphs.length;
  if (ref === undefined || ref === 'current') return Math.min(Math.max(ctx.activeIndex, 0), count - 1);
  if (ref === 'last') return count - 1;
  if (ref < 1 || ref > count) return err(`There is no paragraph ${ref}. The essay has ${plural(count, 'paragraph')}.`);
  return ref - 1;
}

function sentIndex(list: Sentence[], ref: SentRef, p: number): number | Outcome {
  if (list.length === 0) return err(`Paragraph ${p + 1} is empty.`);
  if (ref === 'last') return list.length - 1;
  if (ref < 1 || ref > list.length) {
    return err(`There is no sentence ${ref} in paragraph ${p + 1}. It has ${plural(list.length, 'sentence')}.`);
  }
  return ref - 1;
}

/** With no paragraph named, "the last sentence" means the last one written near the cursor. */
function paraWithText(doc: Doc, ref: ParaRef | undefined, ctx: CommandContext): number | Outcome {
  const p = paraIndex(doc, ref, ctx);
  if (typeof p !== 'number' || ref !== undefined) return p;
  for (let i = p; i >= 0; i--) if (paraText(doc.paragraphs[i]).trim()) return i;
  return p;
}

const isOutcome = (v: number | Outcome): v is Outcome => typeof v !== 'number';

export function resolve(cmd: Command, doc: Doc, ctx: CommandContext): Outcome {
  switch (cmd.k) {
    case 'undo':
      return { k: 'undo' };
    case 'redo':
      return { k: 'redo' };

    case 'count': {
      const total = countWords(docText(doc));
      if (cmd.scope === 'paragraph') {
        const p = paraIndex(doc, cmd.para, ctx);
        if (isOutcome(p)) return p;
        return { k: 'say', text: `Paragraph ${p + 1} has ${plural(countWords(paraText(doc.paragraphs[p])), 'word')}.` };
      }
      if (cmd.scope === 'essay') return { k: 'say', text: `${plural(total, 'word')}.` };
      {
        if (!ctx.wordLimit) return { k: 'say', text: `${plural(total, 'word')} so far. No word limit is set for this essay.` };
        const left = ctx.wordLimit - total;
        return {
          k: 'say',
          text: left >= 0
            ? `${plural(left, 'word')} left of ${ctx.wordLimit}.`
            : `${plural(-left, 'word')} over the limit of ${ctx.wordLimit}.`,
        };
      }
    }

    case 'read': {
      if (cmd.what === 'essay') {
        const text = docText(doc).trim();
        return text ? { k: 'say', text, read: true } : err('The essay is empty.');
      }
      if (cmd.what === 'paragraph') {
        const p = paraIndex(doc, cmd.para, ctx);
        if (isOutcome(p)) return p;
        const text = paraText(doc.paragraphs[p]).trim();
        return text ? { k: 'say', text, read: true } : err(`Paragraph ${p + 1} is empty.`);
      }
      const p = paraWithText(doc, cmd.para, ctx);
      if (isOutcome(p)) return p;
      const list = sentences(paraText(doc.paragraphs[p]));
      const s = sentIndex(list, cmd.sent, p);
      if (isOutcome(s)) return s;
      return { k: 'say', text: list[s].text, read: true };
    }

    case 'delete': {
      if (cmd.what === 'paragraph') {
        const p = paraIndex(doc, cmd.para, ctx);
        if (isOutcome(p)) return p;
        const op: Op = doc.paragraphs.length === 1 ? { k: 'setParagraph', index: 0, nodes: [] } : { k: 'deleteParagraph', index: p };
        return { k: 'edit', op, label: `Deleting P${p + 1}`, done: `Deleted P${p + 1}` };
      }
      const p = paraWithText(doc, cmd.para, ctx);
      if (isOutcome(p)) return p;
      const nodes = doc.paragraphs[p].nodes;
      const list = sentences(paraText(doc.paragraphs[p]));
      const first = sentIndex(list, cmd.from, p);
      if (isOutcome(first)) return first;
      const last = cmd.to === undefined ? first : sentIndex(list, cmd.to, p);
      if (isOutcome(last)) return last;
      if (last < first) return err('Say the lower sentence number first.');
      // Take the space before the removed text too, or after it at the start of the paragraph.
      const from = first > 0 ? list[first - 1].end : list[first].start;
      const to = first > 0 ? list[last].end : (list[last + 1]?.start ?? list[last].end);
      const end = paraText(doc.paragraphs[p]).length;
      const kept = tidy([...sliceNodes(nodes, 0, from), ...sliceNodes(nodes, to, end)]);
      const name = first === last ? `P${p + 1}·S${first + 1}` : `P${p + 1}·S${first + 1}–S${last + 1}`;
      return { k: 'edit', op: { k: 'setParagraph', index: p, nodes: kept }, label: `Deleting ${name}`, done: `Deleted ${name}` };
    }

    case 'move': {
      const from = paraIndex(doc, cmd.para, ctx);
      if (isOutcome(from)) return from;
      const lastIndex = doc.paragraphs.length - 1;
      let to: number;
      let how: string;
      if (cmd.where === 'above' || cmd.where === 'below') {
        const target = paraIndex(doc, cmd.target, ctx);
        if (isOutcome(target)) return target;
        if (target === from) return err('That paragraph is already there.');
        // Index after the paragraph has been lifted out.
        const t = target > from ? target - 1 : target;
        to = cmd.where === 'above' ? t : t + 1;
        how = `${cmd.where} P${target + 1}`;
      } else {
        to = cmd.where === 'top' ? 0 : cmd.where === 'bottom' ? lastIndex : cmd.where === 'up' ? from - 1 : from + 1;
        how = cmd.where === 'top' ? 'to the top' : cmd.where === 'bottom' ? 'to the end' : cmd.where;
      }
      if (to < 0 || to > lastIndex || to === from) return err(`Paragraph ${from + 1} is already there.`);
      return { k: 'edit', op: { k: 'moveParagraph', from, to }, label: `Moving P${from + 1} ${how}`, done: `Moved P${from + 1} ${how}` };
    }

    case 'replace': {
      let scope: number[];
      if (cmd.para === undefined) scope = doc.paragraphs.map((_, i) => i);
      else {
        const p = paraIndex(doc, cmd.para, ctx);
        if (isOutcome(p)) return p;
        scope = [p];
      }
      const escaped = cmd.find.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
      const re = new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, 'giu');
      let hits = 0;
      const ops: Op[] = [];
      for (const i of scope) {
        let changed = false;
        const nodes = doc.paragraphs[i].nodes.map((n): Inline => {
          if (n.t !== 'text') return n;
          const text = n.text.replace(re, (found) => {
            hits++;
            changed = true;
            const foundCap = /^\p{Lu}/u.test(found);
            const saidCap = /^\p{Lu}/u.test(cmd.find);
            // Keep a capital if the word being replaced had one.
            if (foundCap && !saidCap) return cmd.with.replace(/\p{L}/u, (c) => c.toUpperCase());
            // Whisper writes "Replace Happy with Relieved": those capitals are its own, not the writer's.
            if (!foundCap && saidCap) return cmd.with.replace(/\p{L}/u, (c) => c.toLowerCase());
            return cmd.with;
          });
          return { t: 'text', text };
        });
        if (changed) ops.push({ k: 'setParagraph', index: i, nodes });
      }
      const where = scope.length === 1 ? ` in P${scope[0] + 1}` : '';
      if (hits === 0) return { k: 'error', text: `“${cmd.find}” is not${where ? where : ' in the essay'}.`, notFound: true };
      const what = `“${cmd.find}” with “${cmd.with}”${where}${hits > 1 ? ` (${hits} places)` : ''}`;
      return { k: 'edit', op: ops.length === 1 ? ops[0] : { k: 'batch', ops }, label: `Replacing ${what}`, done: `Replaced ${what}` };
    }

    case 'deleteUtterance':
    case 'goto':
    case 'gotoEnd':
    case 'mode':
      return { k: 'app' };

    case 'deleteWords': {
      const count = cmd.count;
      if (!Number.isInteger(count) || count < 1) return err('Say how many words to delete.');
      const last = doc.paragraphs.length - 1;
      const here = ctx.cursor && ctx.cursor.index <= last ? ctx.cursor : null;
      const hereList = here ? sentences(paraText(doc.paragraphs[here.index])) : [];
      const atEnd = !here || (here.index === last && here.sentence >= hereList.length - 1);
      if (!cmd.where && !atEnd) {
        // Two readings: never guess on a deletion.
        const what = plural(count, 'word');
        return {
          k: 'ask',
          question: `The last ${what} before where you are in paragraph ${here!.index + 1}, or the last ${what} of the essay?`,
          choices: [
            { say: ['here', 'where i am', 'before', 'first', 'the first', 'this paragraph', `paragraph ${here!.index + 1}`], cmd: { ...cmd, where: 'here' } },
            { say: ['essay', 'end', 'the end', 'second', 'the second', 'last', 'of the essay'], cmd: { ...cmd, where: 'end' } },
          ],
        };
      }
      // The stretch of text the words are taken from the end of.
      let p: number;
      let limit: number;
      if (cmd.where === 'here' && here) {
        p = here.index;
        limit = hereList[Math.min(here.sentence, hereList.length - 1)]?.end ?? paraText(doc.paragraphs[p]).length;
      } else {
        const found = paraWithText(doc, undefined, { ...ctx, activeIndex: cmd.where === 'end' ? last : ctx.activeIndex });
        if (isOutcome(found)) return found;
        p = found;
        limit = paraText(doc.paragraphs[p]).length;
      }
      const text = paraText(doc.paragraphs[p]);
      // Words are counted the way the word count counts them: runs of non-space holding a letter or digit.
      const found = [...text.slice(0, limit).matchAll(/\S+/g)].filter((m) => /[\p{L}\p{N}]/u.test(m[0]));
      if (found.length === 0) return err(`Paragraph ${p + 1} is empty.`);
      if (count > found.length) return err(`There are only ${plural(found.length, 'word')} there, in paragraph ${p + 1}.`);
      const from = found[found.length - count].index;
      const nodes = doc.paragraphs[p].nodes;
      // The space before the removed words goes with them.
      const kept = tidy([...sliceNodes(nodes, 0, text.slice(0, from).trimEnd().length), ...sliceNodes(nodes, limit, text.length)]);
      const what = `the last ${plural(count, 'word')} of P${p + 1}`;
      return { k: 'edit', op: { k: 'setParagraph', index: p, nodes: kept }, label: `Deleting ${what}`, done: `Deleted ${what}` };
    }

    case 'insert': {
      const p = paraIndex(doc, cmd.para, ctx);
      if (isOutcome(p)) return p;
      const nodes = doc.paragraphs[p].nodes;
      const text = paraText(doc.paragraphs[p]);
      const list = sentences(text);
      // The inserted words are the speaker's own, cleaned by the same rules as all dictation.
      const pieces: Inline[] = clean(cmd.words, { final: true }).pieces.flatMap((x): Inline[] =>
        x.t === 'break' ? [{ t: 'text', text: ' ' }] : [x],
      );
      if (pieces.length === 0) return err('There was nothing to insert.');

      let after: number; // number of sentences the new text comes after
      if (cmd.at.k === 'start') after = 0;
      else if (cmd.at.k === 'end') after = list.length;
      else if (cmd.at.k === 'between') {
        if (cmd.at.b !== cmd.at.a + 1) return err(`Sentences ${cmd.at.a} and ${cmd.at.b} are not next to each other.`);
        for (const n of [cmd.at.a, cmd.at.b]) {
          const s = sentIndex(list, n, p);
          if (isOutcome(s)) return s;
        }
        after = cmd.at.a;
      } else {
        const s = sentIndex(list, cmd.at.sent, p);
        if (isOutcome(s)) return s;
        after = cmd.at.k === 'after' ? s + 1 : s;
      }

      const space: Inline = { t: 'text', text: ' ' };
      let next: Inline[];
      if (list.length === 0) next = pieces;
      else if (after === 0) {
        const at = list[0].start;
        next = [...sliceNodes(nodes, 0, at), ...pieces, space, ...sliceNodes(nodes, at, text.length)];
      } else {
        const at = list[after - 1].end;
        next = [...sliceNodes(nodes, 0, at), space, ...pieces, ...sliceNodes(nodes, at, text.length)];
      }
      const where = list.length === 0 || after === 0 ? `at the start of P${p + 1}` : `after P${p + 1}·S${after}`;
      return { k: 'edit', op: { k: 'setParagraph', index: p, nodes: tidy(next) }, label: `Inserting ${where}`, done: `Inserted ${where}` };
    }
  }
}

/** One part of a dictated utterance: the paragraph it went into and its exact text there. */
export interface SegmentPart {
  paraId: string;
  text: string;
}

/**
 * Remove a dictated utterance, wherever its text now sits. Each part is removed
 * only if its text is still found, word for word, in the paragraph it went
 * into; otherwise nothing is touched and Scribe says so.
 */
export function removeSegment(doc: Doc, parts: SegmentPart[]): Outcome {
  const ops: Op[] = [];
  const removed: number[] = [];
  for (const part of parts) {
    const index = doc.paragraphs.findIndex((p) => p.id === part.paraId);
    const text = index < 0 ? '' : paraText(doc.paragraphs[index]);
    const at = part.text ? text.lastIndexOf(part.text) : -1;
    if (index < 0 || at < 0) return err('What you just said has since been changed, so Scribe left it alone.');
    const nodes = doc.paragraphs[index].nodes;
    // Take the space before it too, or the space after it at the start of the paragraph.
    const from = text.slice(0, at).trimEnd().length;
    const afterEnd = at + part.text.length;
    const to = from === 0 ? afterEnd + (text.slice(afterEnd).length - text.slice(afterEnd).trimStart().length) : afterEnd;
    const kept = tidy([...sliceNodes(nodes, 0, from), ...sliceNodes(nodes, to, text.length)]);
    ops.push({ k: 'setParagraph', index, nodes: kept });
    if (kept.length === 0) removed.push(index);
  }
  if (ops.length === 0) return err('There is nothing you just said to delete.');
  // A paragraph that the utterance itself started, and that is now empty, goes too.
  for (const index of removed.slice(1).sort((a, b) => b - a)) {
    if (doc.paragraphs.length - removed.slice(1).length >= 1) ops.push({ k: 'deleteParagraph', index });
  }
  return { k: 'edit', op: ops.length === 1 ? ops[0] : { k: 'batch', ops }, label: 'Deleting what you just said', done: 'Deleted what you just said' };
}
