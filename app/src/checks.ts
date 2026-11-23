/** Final checks done in code. They only point things out; nothing is fixed automatically. */
import { countWords, sentences } from './doc/segment';
import { docText, paraText, type Doc } from './doc/types';

export interface Finding {
  level: 'ok' | 'warn';
  text: string;
  /** Where it is, like "P2·S1", when it has a place. */
  where?: string;
}

export function mechanicalChecks(doc: Doc, wordLimit: number | null): Finding[] {
  const out: Finding[] = [];
  const total = countWords(docText(doc));

  if (!wordLimit) out.push({ level: 'warn', text: `${total} words. No word limit is set, so the length was not checked.` });
  else if (total > wordLimit) out.push({ level: 'warn', text: `${total} words: ${total - wordLimit} over the ${wordLimit}-word limit.` });
  else out.push({ level: 'ok', text: `${total} words, within the ${wordLimit}-word limit (${wordLimit - total} to spare).` });

  let flagged = 0;
  doc.paragraphs.forEach((p, pi) => {
    const text = paraText(p);
    const P = `P${pi + 1}`;
    flagged += p.nodes.filter((n) => n.t === 'flag').length;
    if (!text.trim()) {
      if (doc.paragraphs.length > 1) out.push({ level: 'warn', text: 'This paragraph is empty.', where: P });
      return;
    }
    if (/ {2,}/.test(text.trim())) out.push({ level: 'warn', text: 'There is a double space.', where: P });
    if ((text.match(/[“"]/g)?.length ?? 0) !== (text.match(/[”"]/g)?.length ?? 0) || (text.match(/"/g)?.length ?? 0) % 2 === 1) {
      out.push({ level: 'warn', text: 'A quotation mark is opened or closed without its partner.', where: P });
    }
    const list = sentences(text);
    if (/^\s*\p{Ll}/u.test(text)) out.push({ level: 'warn', text: 'The paragraph starts without a capital.', where: P });
    // A small letter right after a sentence end (the splitter does not treat these as new sentences).
    for (const m of text.matchAll(/(\S+)[.?!]["”]?\s+(\p{Ll}[^.?!]{0,30})/gu)) {
      if (/^(a\.m|p\.m|e\.g|i\.e|etc|vs|mr|mrs|ms|dr|st)$/i.test(m[1])) continue;
      out.push({ level: 'warn', text: `A sentence may start without a capital: “${m[2].trim()}”`, where: P });
    }
    list.forEach((s, si) => {
      const where = `${P}·S${si + 1}`;
      const repeat = s.text.match(/\b(\p{L}+)\s+\1\b/iu);
      if (repeat && !/^(had|that|very|really|so|no)$/i.test(repeat[1])) {
        out.push({ level: 'warn', text: `The word “${repeat[1]}” is repeated.`, where });
      }
    });
    const last = list.at(-1);
    if (last && !/[.?!]["”')\]]*$/.test(last.text)) {
      out.push({ level: 'warn', text: 'The paragraph does not end with a period, question mark or exclamation point.', where: `${P}·S${list.length}` });
    }
  });
  if (flagged) out.push({ level: 'warn', text: `${flagged} highlighted ${flagged === 1 ? 'word still needs' : 'words still need'} a decision (click a yellow highlight).` });
  return out;
}

/** "P2·S3" for the sentence that contains this exact text, if any. */
export function locate(doc: Doc, quote: string): string | undefined {
  const q = quote.trim().toLowerCase();
  if (!q) return undefined;
  for (const [pi, p] of doc.paragraphs.entries()) {
    const text = paraText(p);
    const at = text.toLowerCase().indexOf(q);
    if (at < 0) continue;
    const si = sentences(text).findIndex((s) => at >= s.start && at < s.end);
    return si >= 0 ? `P${pi + 1}·S${si + 1}` : `P${pi + 1}`;
  }
  return undefined;
}
