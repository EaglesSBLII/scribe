/**
 * Papers: headings, numbered equations and figure captions, laid out by a
 * format that can be learned from a sample paper. The essay text itself is
 * never changed; numbers and labels are added only when it is shown or exported.
 *
 * In the essay, a paragraph starting with "# " is a heading, "## " a
 * subheading, "Figure: " a caption, and a paragraph holding one equation
 * between double dollar signs is a numbered equation.
 */
import { paraText, type Doc, type Inline } from '../doc/types';

export interface FormatProfile {
  id: string;
  name: string;
  page: { size: 'letter' | 'a4'; marginIn: number };
  body: { font: 'serif' | 'sans'; sizePt: number; lineSpacing: number };
  headings: { numbering: 'none' | 'arabic' | 'roman'; dot: boolean; bold: boolean; caps: boolean; sizePt: number };
  equations: { numbered: boolean; style: 'plain' | 'section' };
  captions: { label: string; separator: ':' | '.' };
  /** What the sample showed, and what could not be found in it. */
  notes: string[];
}

export const DEFAULT_FORMAT: FormatProfile = {
  id: 'default',
  name: 'Scribe default',
  page: { size: 'letter', marginIn: 1 },
  body: { font: 'serif', sizePt: 12, lineSpacing: 1.5 },
  headings: { numbering: 'none', dot: false, bold: true, caps: false, sizePt: 14 },
  equations: { numbered: true, style: 'plain' },
  captions: { label: 'Figure', separator: ':' },
  notes: [],
};

export type Block =
  | { k: 'heading'; level: 1 | 2; number: string; text: string }
  | { k: 'para'; nodes: Inline[] }
  | { k: 'equation'; latex: string; number: string }
  | { k: 'caption'; label: string; text: string };

const ROMAN: [number, string][] = [[10, 'X'], [9, 'IX'], [5, 'V'], [4, 'IV'], [1, 'I']];
export function roman(n: number): string {
  let out = '';
  for (const [value, mark] of ROMAN) while (n >= value) { out += mark; n -= value; }
  return out;
}

/** What kind of block a paragraph is, from its own text. */
export function kindOf(nodes: Inline[]): 'heading1' | 'heading2' | 'caption' | 'equation' | 'para' {
  const only = nodes.filter((n) => n.t !== 'text' || n.text.trim());
  if (only.length === 1 && only[0].t === 'math' && only[0].display) return 'equation';
  const text = paraText({ id: '', nodes });
  if (/^##\s+\S/.test(text)) return 'heading2';
  if (/^#\s+\S/.test(text)) return 'heading1';
  if (/^(figure|fig\.?)\s*:\s*\S/i.test(text)) return 'caption';
  return 'para';
}

export function layout(doc: Doc, format: FormatProfile = DEFAULT_FORMAT): Block[] {
  const blocks: Block[] = [];
  let section = 0;
  let sub = 0;
  let equation = 0;
  let figure = 0;
  for (const p of doc.paragraphs) {
    const text = paraText(p);
    if (!text.trim()) continue;
    const kind = kindOf(p.nodes);
    if (kind === 'heading1' || kind === 'heading2') {
      const level = kind === 'heading1' ? 1 : 2;
      let title = text.replace(/^#+\s+/, '').trim();
      if (format.headings.caps && level === 1) title = title.toUpperCase();
      let number = '';
      if (level === 1) {
        section++;
        sub = 0;
        if (format.equations.style === 'section') equation = 0;
        if (format.headings.numbering === 'arabic') number = `${section}${format.headings.dot ? '.' : ''}`;
        if (format.headings.numbering === 'roman') number = `${roman(section)}.`;
      } else {
        sub++;
        if (format.headings.numbering === 'arabic') number = `${section}.${sub}${format.headings.dot ? '.' : ''}`;
        // The usual partner of roman section numbers is lettered subsections.
        if (format.headings.numbering === 'roman') number = `${String.fromCharCode(64 + Math.min(sub, 26))}.`;
      }
      blocks.push({ k: 'heading', level, number, text: title });
    } else if (kind === 'equation') {
      equation++;
      const latex = (p.nodes.find((n) => n.t === 'math') as Extract<Inline, { t: 'math' }>).latex;
      const number = !format.equations.numbered ? '' : format.equations.style === 'section' && section > 0 ? `(${section}.${equation})` : `(${equation})`;
      blocks.push({ k: 'equation', latex, number });
    } else if (kind === 'caption') {
      figure++;
      blocks.push({ k: 'caption', label: `${format.captions.label} ${figure}${format.captions.separator}`, text: text.replace(/^(figure|fig\.?)\s*:\s*/i, '').trim() });
    } else {
      blocks.push({ k: 'para', nodes: p.nodes });
    }
  }
  return blocks;
}

export const hasPaperParts = (doc: Doc) => doc.paragraphs.some((p) => p.nodes.some((n) => n.t === 'math') || kindOf(p.nodes) !== 'para');
