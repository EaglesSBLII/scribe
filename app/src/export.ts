/**
 * Export the essay to .txt, .docx or .pdf, made on this machine. The words are
 * exactly as written. A paper format (Scribe's default, or one learned from a
 * sample) adds only layout: heading numbers, equation numbers, caption labels.
 */
import { nodeText, type Doc, type Inline } from './doc/types';
import { DEFAULT_FORMAT, hasPaperParts, layout, type Block, type FormatProfile } from './paper/layout';

export type ExportFormat = 'txt' | 'docx' | 'pdf';

const MIME: Record<ExportFormat, string> = {
  txt: 'text/plain;charset=utf-8',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  pdf: 'application/pdf',
};

export function fileName(title: string, format: ExportFormat): string {
  const safe = title.replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim() || 'Essay';
  return `${safe}.${format}`;
}

const SUPER: Record<string, string> = { 0: '⁰', 1: '¹', 2: '²', 3: '³', 4: '⁴', 5: '⁵', 6: '⁶', 7: '⁷', 8: '⁸', 9: '⁹', '+': '⁺', '-': '⁻', n: 'ⁿ', i: 'ⁱ' };
const SUB: Record<string, string> = { 0: '₀', 1: '₁', 2: '₂', 3: '₃', 4: '₄', 5: '₅', 6: '₆', 7: '₇', 8: '₈', 9: '₉', '+': '₊', '-': '₋', i: 'ᵢ', n: 'ₙ' };
const SYMBOLS: Record<string, string> = {
  alpha: 'α', beta: 'β', gamma: 'γ', delta: 'δ', epsilon: 'ε', zeta: 'ζ', eta: 'η', theta: 'θ', iota: 'ι', kappa: 'κ', lambda: 'λ', mu: 'μ', nu: 'ν',
  xi: 'ξ', pi: 'π', rho: 'ρ', sigma: 'σ', tau: 'τ', upsilon: 'υ', phi: 'φ', chi: 'χ', psi: 'ψ', omega: 'ω', Gamma: 'Γ', Delta: 'Δ', Theta: 'Θ',
  Lambda: 'Λ', Xi: 'Ξ', Pi: 'Π', Sigma: 'Σ', Phi: 'Φ', Psi: 'Ψ', Omega: 'Ω', int: '∫', iint: '∬', oint: '∮', sum: '∑', prod: '∏', infty: '∞',
  times: '×', cdot: '·', div: '÷', pm: '±', leq: '≤', geq: '≥', neq: '≠', approx: '≈', propto: '∝', to: '→', Rightarrow: '⇒', partial: '∂',
  nabla: '∇', hbar: 'ℏ', circ: '°', lim: 'lim', sin: 'sin', cos: 'cos', tan: 'tan', sec: 'sec', csc: 'csc', cot: 'cot', log: 'log', ln: 'ln',
  exp: 'exp', arcsin: 'arcsin', arccos: 'arccos', arctan: 'arctan',
};

/**
 * Mathematics as one line of ordinary characters ("∫₀^π sin x dx", "x²/2"),
 * for formats that cannot hold typeset equations. Nothing is changed or
 * simplified; it is the same expression written flat.
 */
export function latexToText(latex: string): string {
  let s = latex;
  const script = (body: string, map: Record<string, string>, mark: string) =>
    [...body].every((c) => c in map) ? [...body].map((c) => map[c]).join('') : `${mark}(${body})`;
  // Innermost braces first, until none are left.
  for (let guard = 0; guard < 50; guard++) {
    const before = s;
    s = s
      .replace(/\\frac\{([^{}]*)\}\{([^{}]*)\}/g, (_m, a: string, b: string) => `${/^[\w.]+$/.test(a) ? a : `(${a})`}/${/^[\w.]+$/.test(b) ? b : `(${b})`}`)
      .replace(/\\sqrt\[3\]\{([^{}]*)\}/g, '∛($1)')
      .replace(/\\sqrt\{([^{}]*)\}/g, '√($1)')
      .replace(/\\(?:mathrm|text)\{([^{}]*)\}/g, '$1')
      .replace(/\\vec\{([^{}]*)\}/g, '$1⃗')
      .replace(/\\hat\{([^{}]*)\}/g, '$1̂')
      .replace(/\\bar\{([^{}]*)\}/g, '$1̄')
      .replace(/\\ddot\{([^{}]*)\}/g, '$1̈')
      .replace(/\\dot\{([^{}]*)\}/g, '$1̇')
      .replace(/\^\{([^{}]*)\}/g, (_m, b: string) => script(b, SUPER, '^'))
      .replace(/_\{([^{}]*)\}/g, (_m, b: string) => script(b, SUB, '_'));
    if (s === before) break;
  }
  return s
    .replace(/\\left|\\right/g, '')
    .replace(/\\,/g, ' ')
    .replace(/\\([A-Za-z]+)/g, (_m, name: string) => SYMBOLS[name] ?? name)
    .replace(/\s+/g, ' ')
    .trim()
    // Letters with marks (ẍ) are stored as single characters where one exists.
    .normalize('NFC');
}

const inlineText = (nodes: Inline[], math: (latex: string) => string) => nodes.map((n) => (n.t === 'math' ? math(n.latex) : n.text)).join('').trim();
const headingText = (b: Extract<Block, { k: 'heading' }>) => (b.number ? `${b.number} ${b.text}` : b.text);

export function toTxt(doc: Doc, format: FormatProfile = DEFAULT_FORMAT): string {
  // A plain essay stays exactly as it was typed.
  if (!hasPaperParts(doc)) {
    return doc.paragraphs.map((p) => p.nodes.map(nodeText).join('').trim()).filter(Boolean).join('\n\n') + '\n';
  }
  return (
    layout(doc, format)
      .map((b) => {
        if (b.k === 'heading') return headingText(b);
        if (b.k === 'equation') return `    ${latexToText(b.latex)}${b.number ? `    ${b.number}` : ''}`;
        if (b.k === 'caption') return `${b.label} ${b.text}`;
        return inlineText(b.nodes, latexToText);
      })
      .join('\n\n') + '\n'
  );
}

export async function toDocx(doc: Doc, format: FormatProfile = DEFAULT_FORMAT): Promise<Blob> {
  const { AlignmentType, Document, Packer, Paragraph, TabStopPosition, TabStopType, TextRun } = await import('docx');
  const font = format.body.font === 'sans' ? 'Arial' : 'Times New Roman';
  const size = Math.round(format.body.sizePt * 2);
  const line = Math.round(format.body.lineSpacing * 240);
  const margin = Math.round(format.page.marginIn * 1440);
  const [width, height] = format.page.size === 'a4' ? [11906, 16838] : [12240, 15840];

  const children = layout(doc, format).map((b) => {
    if (b.k === 'heading') {
      return new Paragraph({
        spacing: { before: 240, after: 120 },
        children: [new TextRun({ text: headingText(b), bold: format.headings.bold, size: Math.round((b.level === 1 ? format.headings.sizePt : Math.max(format.body.sizePt, format.headings.sizePt - 1)) * 2) })],
      });
    }
    if (b.k === 'equation') {
      // Centred, with its number against the right margin.
      return new Paragraph({
        spacing: { before: 120, after: 120, line },
        tabStops: [{ type: TabStopType.CENTER, position: TabStopPosition.MAX / 2 }, { type: TabStopType.RIGHT, position: TabStopPosition.MAX }],
        children: [new TextRun({ text: `\t${latexToText(b.latex)}${b.number ? `\t${b.number}` : ''}`, font: 'Cambria Math' })],
      });
    }
    if (b.k === 'caption') {
      return new Paragraph({
        alignment: AlignmentType.CENTER,
        spacing: { before: 60, after: 240 },
        children: [new TextRun({ text: `${b.label} `, bold: true, size: size - 2 }), new TextRun({ text: b.text, size: size - 2 })],
      });
    }
    return new Paragraph({
      spacing: { after: 240, line },
      children: b.nodes.map((n) => (n.t === 'math' ? new TextRun({ text: latexToText(n.latex), font: 'Cambria Math' }) : new TextRun(n.text))),
    });
  });

  const file = new Document({
    styles: { default: { document: { run: { font, size } } } },
    sections: [{ properties: { page: { size: { width, height }, margin: { top: margin, bottom: margin, left: margin, right: margin } } }, children }],
  });
  return Packer.toBlob(file);
}

/** A plain essay as a simple PDF, drawn directly. */
export async function toPdf(doc: Doc): Promise<Uint8Array> {
  const { PDFDocument, StandardFonts } = await import('pdf-lib');
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.TimesRoman);
  const size = 12;
  const lineHeight = 18;
  const margin = 72; // one inch
  const [width, height] = [612, 792]; // US Letter
  const maxWidth = width - margin * 2;

  // The built-in PDF font cannot draw every character; swap the few it lacks.
  const drawable = (text: string) =>
    [...text].map((c) => {
      try {
        font.encodeText(c);
        return c;
      } catch {
        return '?';
      }
    }).join('');

  let page = pdf.addPage([width, height]);
  let y = height - margin;
  const line = (text: string) => {
    if (y < margin) {
      page = pdf.addPage([width, height]);
      y = height - margin;
    }
    page.drawText(text, { x: margin, y, size, font });
    y -= lineHeight;
  };

  for (const para of doc.paragraphs.map((p) => p.nodes.map(nodeText).join('').trim()).filter(Boolean)) {
    let current = '';
    for (const word of drawable(para).split(/\s+/)) {
      const next = current ? `${current} ${word}` : word;
      if (current && font.widthOfTextAtSize(next, size) > maxWidth) {
        line(current);
        current = word;
      } else current = next;
    }
    if (current) line(current);
    y -= lineHeight / 2;
  }
  return pdf.save();
}

/**
 * Build the page that is printed to PDF: typeset mathematics, numbered
 * equations, headings and captions in the chosen format.
 */
export async function buildPrintRoot(title: string, doc: Doc, format: FormatProfile): Promise<HTMLElement> {
  const katex = (await import('katex')).default;
  document.getElementById('print-root')?.remove();
  const root = document.createElement('div');
  root.id = 'print-root';
  root.dataset.title = title;
  const family = format.body.font === 'sans' ? 'Helvetica, Arial, sans-serif' : '"Times New Roman", Times, serif';
  root.style.cssText = `font-family:${family};font-size:${format.body.sizePt}pt;line-height:${format.body.lineSpacing * 1.2};color:#000;`;

  const style = document.createElement('style');
  style.textContent = `@page { size: ${format.page.size === 'a4' ? 'A4' : 'letter'}; margin: ${format.page.marginIn}in; }`;
  root.append(style);

  const el = <K extends keyof HTMLElementTagNameMap>(tag: K, css: string, kind: string) => {
    const node = document.createElement(tag);
    node.style.cssText = css;
    node.dataset.block = kind;
    root.append(node);
    return node;
  };
  const inline = (parent: HTMLElement, nodes: Inline[]) => {
    for (const n of nodes) {
      const span = document.createElement('span');
      if (n.t === 'math') katex.render(n.latex, span, { throwOnError: false });
      else span.textContent = n.text;
      parent.append(span);
    }
  };

  for (const b of layout(doc, format)) {
    if (b.k === 'heading') {
      const size = b.level === 1 ? format.headings.sizePt : Math.max(format.body.sizePt, format.headings.sizePt - 1);
      el(b.level === 1 ? 'h2' : 'h3', `font-size:${size}pt;font-weight:${format.headings.bold ? 700 : 400};margin:1.2em 0 0.4em;break-after:avoid;`, 'heading').textContent = headingText(b);
    } else if (b.k === 'equation') {
      const row = el('div', 'display:flex;align-items:center;margin:0.8em 0;break-inside:avoid;', 'equation');
      const math = document.createElement('div');
      math.style.cssText = 'flex:1;text-align:center;';
      katex.render(b.latex, math, { throwOnError: false, displayMode: true });
      const number = document.createElement('span');
      number.dataset.part = 'equation-number';
      number.textContent = b.number;
      row.append(math, number);
    } else if (b.k === 'caption') {
      const p = el('p', `text-align:center;font-size:${Math.max(8, format.body.sizePt - 1)}pt;margin:0.4em 0 1.2em;`, 'caption');
      const label = document.createElement('strong');
      label.textContent = `${b.label} `;
      p.append(label, b.text);
    } else {
      inline(el('p', 'margin:0 0 0.9em;', 'para'), b.nodes);
    }
  }
  document.body.append(root);
  return root;
}

export async function exportEssay(title: string, doc: Doc, type: ExportFormat, format: FormatProfile | null = null): Promise<void> {
  // Mathematics and learned formats need real typesetting, which the print path provides.
  if (type === 'pdf' && (format || hasPaperParts(doc))) {
    const root = await buildPrintRoot(title, doc, format ?? DEFAULT_FORMAT);
    const previous = document.title;
    // The print dialog offers "Save as PDF", and uses the page title as the file name.
    document.title = fileName(title, 'pdf').replace(/\.pdf$/, '');
    window.addEventListener('afterprint', () => {
      document.title = previous;
      root.remove();
    }, { once: true });
    window.print();
    return;
  }
  const used = format ?? DEFAULT_FORMAT;
  const data = type === 'txt' ? toTxt(doc, used) : type === 'docx' ? await toDocx(doc, used) : await toPdf(doc);
  const blob = data instanceof Blob ? data : new Blob([data as BlobPart], { type: MIME[type] });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName(title, type);
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
