/** The essay document. Text is addressed by paragraph and sentence. */

export type Inline =
  | { t: 'text'; text: string }
  /** Dictated math, stored as LaTeX. `display` marks an equation on its own line. */
  | { t: 'math'; latex: string; display?: boolean }
  /** A word that might have been a spoken command. `alt` is the other reading. */
  | { t: 'flag'; text: string; alt: string; cap?: boolean };

export interface Paragraph {
  id: string;
  nodes: Inline[];
}

export interface Doc {
  paragraphs: Paragraph[];
}

export function newId(): string {
  return globalThis.crypto.randomUUID();
}

export function emptyParagraph(): Paragraph {
  return { id: newId(), nodes: [] };
}

export function emptyDoc(): Doc {
  return { paragraphs: [emptyParagraph()] };
}

/** Plain-text form of one node. Math is written between dollar signs; doubled for an equation on its own line. */
export function nodeText(n: Inline): string {
  if (n.t !== 'math') return n.text;
  const mark = n.display ? '$$' : '$';
  return mark + n.latex + mark;
}

export function paraText(p: Paragraph): string {
  return p.nodes.map(nodeText).join('');
}

/** Parse plain text back into inline nodes. `$...$` becomes math. */
export function textToNodes(text: string): Inline[] {
  const nodes: Inline[] = [];
  const re = /\$\$([^$]+)\$\$|\$([^$\n]+)\$/g;
  let last = 0;
  for (const m of text.matchAll(re)) {
    if (m.index > last) nodes.push({ t: 'text', text: text.slice(last, m.index) });
    nodes.push(m[1] !== undefined ? { t: 'math', latex: m[1].trim(), display: true } : { t: 'math', latex: m[2] });
    last = m.index + m[0].length;
  }
  if (last < text.length) nodes.push({ t: 'text', text: text.slice(last) });
  return nodes;
}

export function docText(doc: Doc): string {
  return doc.paragraphs.map(paraText).join('\n\n');
}
