/**
 * Learns a paper's formatting from an uploaded sample (PDF or DOCX): page and
 * body settings, how headings are numbered, how equations are numbered, and
 * how figure captions are labelled. Only the formatting is kept. None of the
 * sample's text is stored, and the file never leaves this machine.
 */
import { DEFAULT_FORMAT, type FormatProfile } from './layout';

/** One line of the sample, reduced to what formatting can be read from. */
export interface Line {
  text: string;
  sizePt: number;
  bold: boolean;
  /** Left edge, in points from the left of the page. */
  x: number;
  /** Distance down the page in points, when known. */
  y?: number;
  page?: number;
}

export interface PageInfo {
  widthPt: number;
  marginLeftPt?: number;
  lineSpacing?: number;
  fontFamily?: string;
}

const median = (values: number[]) => {
  if (!values.length) return 0;
  const s = [...values].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};
const most = <T,>(values: T[]): T | undefined => {
  const counts = new Map<T, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
};
const snap = (value: number, options: number[]) => options.reduce((best, o) => (Math.abs(o - value) < Math.abs(best - value) ? o : best), options[0]);

const CAPTION = /^(Figure|FIGURE|Fig\.|FIG\.)\s*\d+\s*([:.])/;
const EQUATION_NUMBER = /\((\d+)(\.\d+)?\)\s*$/;
const ARABIC_HEADING = /^(\d+)(\.)?\s+\p{Lu}/u;
const DECIMAL_HEADING = /^\d+\.\d+\.?\s+\S/;
const ROMAN_HEADING = /^(?:[IVX]+)\.\s+\S/;

/** Work out the format from the sample's lines. Pure, so it can be tested with made-up lines. */
export function inferFormat(lines: Line[], page: PageInfo, name: string): FormatProfile {
  const format: FormatProfile = structuredClone({ ...DEFAULT_FORMAT, id: crypto.randomUUID(), name, notes: [] });
  const notes = format.notes;
  const real = lines.filter((l) => l.text.trim().length > 0);
  if (real.length < 5) {
    notes.push('The sample had too little readable text, so Scribe\'s default format is used.');
    return format;
  }

  // Body text: the size that covers the most characters.
  const bySize = new Map<number, number>();
  for (const l of real) bySize.set(Math.round(l.sizePt * 2) / 2, (bySize.get(Math.round(l.sizePt * 2) / 2) ?? 0) + l.text.length);
  const bodySize = [...bySize.entries()].sort((a, b) => b[1] - a[1])[0][0];
  format.body.sizePt = Math.min(14, Math.max(9, bodySize));
  format.body.font = /sans|helvetica|arial|calibri|verdana|tahoma|gothic/i.test(page.fontFamily ?? '') ? 'sans' : 'serif';
  notes.push(`Body text: ${format.body.sizePt} pt ${format.body.font === 'sans' ? 'sans-serif' : 'serif'}.`);

  format.page.size = Math.abs(page.widthPt - 595) < Math.abs(page.widthPt - 612) ? 'a4' : 'letter';
  const body = real.filter((l) => Math.abs(l.sizePt - bodySize) < 0.6 && l.text.length > 40);
  const margin = page.marginLeftPt ?? (body.length ? Math.min(...body.map((l) => l.x)) : 72);
  format.page.marginIn = Math.min(1.5, Math.max(0.5, Math.round((margin / 72) * 20) / 20));

  if (page.lineSpacing) format.body.lineSpacing = snap(page.lineSpacing, [1, 1.15, 1.5, 2]);
  else {
    const gaps: number[] = [];
    for (let i = 1; i < body.length; i++) {
      const [a, b] = [body[i - 1], body[i]];
      if (a.y !== undefined && b.y !== undefined && a.page === b.page && b.y > a.y && b.y - a.y < bodySize * 3) gaps.push((b.y - a.y) / bodySize);
    }
    // Printed line pitch is about 1.2 times the type size at single spacing.
    if (gaps.length >= 3) format.body.lineSpacing = snap(median(gaps) / 1.2, [1, 1.15, 1.5, 2]);
    else notes.push('Line spacing could not be measured; 1.5 is used.');
  }
  notes.push(`Page: ${format.page.size === 'a4' ? 'A4' : 'US Letter'}, ${format.page.marginIn}-inch margins, line spacing ${format.body.lineSpacing}.`);

  // Captions and equation numbers.
  const captions = real.map((l) => CAPTION.exec(l.text.trim())).filter((m): m is RegExpExecArray => m !== null);
  if (captions.length) {
    format.captions.label = most(captions.map((m) => m[1]))!;
    format.captions.separator = most(captions.map((m) => m[2]))! as ':' | '.';
    notes.push(`Figure captions are labelled “${format.captions.label} 1${format.captions.separator}”.`);
  } else notes.push('No figure captions were found; “Figure 1:” is used.');

  const numbered = real.filter((l) => {
    const text = l.text.trim();
    return EQUATION_NUMBER.test(text) && !CAPTION.test(text) && (text.length < 70 || /[=+−∑∫≤≥±×]/.test(text)) && !/[.!?]\s+\p{Lu}/u.test(text);
  });
  if (numbered.length) {
    format.equations.numbered = true;
    format.equations.style = numbered.filter((l) => EQUATION_NUMBER.exec(l.text.trim())![2]).length > numbered.length / 2 ? 'section' : 'plain';
    notes.push(`Equations are numbered ${format.equations.style === 'section' ? 'by section, like (2.1)' : 'in one run, like (1)'}.`);
  } else {
    format.equations.numbered = false;
    notes.push('No numbered equations were found, so equations are not numbered.');
  }

  // Headings: short lines that are larger or bolder than the body and do not end like a sentence.
  const headings = real.filter((l) => {
    const text = l.text.trim();
    if (CAPTION.test(text) || numbered.includes(l)) return false;
    const stands = l.sizePt >= bodySize * 1.08 || l.bold;
    return stands && text.length <= 90 && text.split(/\s+/).length <= 12 && !/[.,;:]$/.test(text) && /\p{L}/u.test(text);
  });
  // The title is the largest line of all; it is not a section heading.
  const largest = Math.max(...headings.map((l) => l.sizePt), 0);
  const sections = headings.filter((l) => !(l.sizePt === largest && largest > bodySize * 1.5 && !ARABIC_HEADING.test(l.text.trim()) && !ROMAN_HEADING.test(l.text.trim())));
  const top = sections.filter((l) => !DECIMAL_HEADING.test(l.text.trim()));
  if (top.length) {
    const roman = top.filter((l) => ROMAN_HEADING.test(l.text.trim())).length;
    const arabic = top.map((l) => ARABIC_HEADING.exec(l.text.trim())).filter((m): m is RegExpExecArray => m !== null);
    if (roman > top.length / 2) format.headings.numbering = 'roman';
    else if (arabic.length > top.length / 2) {
      format.headings.numbering = 'arabic';
      format.headings.dot = arabic.filter((m) => m[2]).length > arabic.length / 2;
    } else format.headings.numbering = 'none';
    const letters = (l: Line) => l.text.replace(/[^\p{L}]/gu, '');
    format.headings.caps = top.filter((l) => letters(l).length > 2 && letters(l) === letters(l).toUpperCase()).length > top.length / 2;
    format.headings.bold = top.filter((l) => l.bold).length >= top.length / 2;
    format.headings.sizePt = Math.min(20, Math.max(format.body.sizePt, Math.round(median(top.map((l) => l.sizePt)) * 2) / 2));
    const how = format.headings.numbering === 'roman' ? 'roman numerals (I., II.)' : format.headings.numbering === 'arabic' ? `numbers (1${format.headings.dot ? '.' : ''}, 2${format.headings.dot ? '.' : ''})` : 'no numbers';
    notes.push(`Headings: ${how}, ${format.headings.sizePt} pt${format.headings.bold ? ', bold' : ''}${format.headings.caps ? ', capitals' : ''}.`);
  } else notes.push('No section headings were found; the default heading style is used.');

  return format;
}

export async function learnFromPdf(data: ArrayBuffer, name: string): Promise<FormatProfile> {
  const pdfjs = await import('pdfjs-dist');
  pdfjs.GlobalWorkerOptions.workerSrc = new URL('pdfjs-dist/build/pdf.worker.min.mjs', import.meta.url).toString();
  const pdf = await pdfjs.getDocument({ data: new Uint8Array(data) }).promise;
  const lines: Line[] = [];
  const lineFonts: string[] = [];
  const fontChars = new Map<string, number>();
  let widthPt = 612;
  let fontFamily = '';
  for (let n = 1; n <= Math.min(pdf.numPages, 8); n++) {
    const page = await pdf.getPage(n);
    const view = page.getViewport({ scale: 1 });
    widthPt = view.width;
    // Loading the page's drawing commands makes the real font names available.
    await page.getOperatorList().catch(() => null);
    const content = await page.getTextContent();
    const rows = new Map<number, { str: string; x: number; width: number; size: number; bold: boolean; font: string }[]>();
    for (const item of content.items) {
      if (!('str' in item) || !item.str.trim()) continue;
      const size = Math.abs(item.transform[3]) || item.height;
      let fontName = '';
      try {
        fontName = (page.commonObjs.get(item.fontName) as { name?: string } | undefined)?.name ?? '';
      } catch { /* font not loaded; weight unknown */ }
      const family = (content.styles as Record<string, { fontFamily?: string }>)[item.fontName]?.fontFamily ?? '';
      if (!fontFamily && item.str.length > 20) fontFamily = `${fontName} ${family}`;
      const y = Math.round(view.height - item.transform[5]);
      const key = [...rows.keys()].find((k) => Math.abs(k - y) <= 2) ?? y;
      fontChars.set(item.fontName, (fontChars.get(item.fontName) ?? 0) + item.str.length);
      rows.set(key, [...(rows.get(key) ?? []), { str: item.str, x: item.transform[4], width: item.width, size, bold: /bold|black|heavy|semibold/i.test(fontName), font: item.fontName }]);
    }
    for (const [y, parts] of [...rows.entries()].sort((a, b) => a[0] - b[0])) {
      parts.sort((a, b) => a.x - b.x);
      let text = '';
      let end = parts[0].x;
      for (const p of parts) {
        if (text && p.x - end > p.size * 0.2 && !text.endsWith(' ')) text += ' ';
        text += p.str;
        end = p.x + p.width;
      }
      const chars = parts.reduce((m, p) => m + p.str.length, 0);
      lines.push({
        text: text.trim(), y, page: n, x: parts[0].x,
        sizePt: Math.max(...parts.map((p) => p.size)),
        bold: parts.filter((p) => p.bold).reduce((m, p) => m + p.str.length, 0) > chars / 2,
      });
      lineFonts.push(parts.reduce((a, b) => (b.str.length > a.str.length ? b : a)).font);
    }
  }
  // A PDF does not always name its fonts. A face used for only a small part of
  // the text, different from the body's, is the heading (bold) face.
  const total = [...fontChars.values()].reduce((a, b) => a + b, 0);
  const bodyFont = [...fontChars.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
  lines.forEach((line, i) => {
    const font = lineFonts[i];
    if (!line.bold && font !== bodyFont && (fontChars.get(font) ?? 0) < total * 0.2) line.bold = true;
  });
  return inferFormat(lines, { widthPt, fontFamily }, name);
}

export async function learnFromDocx(data: ArrayBuffer, name: string): Promise<FormatProfile> {
  const JSZip = (await import('jszip')).default;
  const zip = await JSZip.loadAsync(data);
  const read = async (path: string) => {
    const file = zip.file(path);
    return file ? new DOMParser().parseFromString(await file.async('string'), 'application/xml') : null;
  };
  const doc = await read('word/document.xml');
  if (!doc) throw new Error('This does not look like a Word document.');
  const styles = await read('word/styles.xml');
  const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
  const first = (el: Element | Document | null | undefined, tag: string) => el?.getElementsByTagNameNS(W, tag)[0] ?? null;
  const attr = (el: Element | null, name: string) => el?.getAttributeNS(W, name) ?? el?.getAttribute(`w:${name}`) ?? null;
  const on = (el: Element | null) => el !== null && attr(el, 'val') !== '0' && attr(el, 'val') !== 'false';

  const defaults = first(first(styles, 'docDefaults'), 'rPr');
  const defaultSize = Number(attr(first(defaults, 'sz'), 'val') ?? 22) / 2;
  let fontFamily = attr(first(defaults, 'rFonts'), 'ascii') ?? '';
  const styleInfo = new Map<string, { size?: number; bold: boolean; line?: number }>();
  for (const s of styles ? [...styles.getElementsByTagNameNS(W, 'style')] : []) {
    const id = attr(s, 'styleId');
    if (!id) continue;
    const size = attr(first(first(s, 'rPr'), 'sz'), 'val');
    const line = attr(first(first(s, 'pPr'), 'spacing'), 'line');
    styleInfo.set(id, { size: size ? Number(size) / 2 : undefined, bold: on(first(first(s, 'rPr'), 'b')) || /^heading/i.test(id), line: line ? Number(line) / 240 : undefined });
    if (/^normal$/i.test(id)) fontFamily = attr(first(first(s, 'rPr'), 'rFonts'), 'ascii') ?? fontFamily;
  }

  const section = first(doc, 'sectPr');
  const widthPt = Number(attr(first(section, 'pgSz'), 'w') ?? 12240) / 20;
  const marginLeftPt = Number(attr(first(section, 'pgMar'), 'left') ?? 1440) / 20;
  const lines: Line[] = [];
  const spacings: number[] = [];
  for (const p of [...doc.getElementsByTagNameNS(W, 'p')]) {
    const pPr = first(p, 'pPr');
    const style = styleInfo.get(attr(first(pPr, 'pStyle'), 'val') ?? '') ?? styleInfo.get('Normal');
    const runs = [...p.getElementsByTagNameNS(W, 'r')];
    const text = runs.map((r) => [...r.getElementsByTagNameNS(W, 't')].map((t) => t.textContent ?? '').join('')).join('');
    if (!text.trim()) continue;
    const sizes = runs.map((r) => attr(first(first(r, 'rPr'), 'sz'), 'val')).filter((v): v is string => v !== null).map((v) => Number(v) / 2);
    const boldChars = runs.filter((r) => on(first(first(r, 'rPr'), 'b'))).reduce((n, r) => n + (r.textContent?.length ?? 0), 0);
    const runFont = runs.map((r) => attr(first(first(r, 'rPr'), 'rFonts'), 'ascii')).find(Boolean);
    if (runFont && text.length > 60) fontFamily = runFont;
    const line = attr(first(pPr, 'spacing'), 'line');
    if (line) spacings.push(Number(line) / 240);
    else if (style?.line) spacings.push(style.line);
    lines.push({ text: text.trim(), x: marginLeftPt, sizePt: sizes.length ? Math.max(...sizes) : (style?.size ?? defaultSize), bold: boldChars > text.length / 2 || Boolean(style?.bold) });
  }
  return inferFormat(lines, { widthPt, marginLeftPt, fontFamily, lineSpacing: spacings.length ? median(spacings) : 1 }, name);
}

export async function learnFromFile(file: File): Promise<FormatProfile> {
  const name = file.name.replace(/\.(pdf|docx)$/i, '');
  const data = await file.arrayBuffer();
  if (/\.pdf$/i.test(file.name)) return learnFromPdf(data, name);
  if (/\.docx$/i.test(file.name)) return learnFromDocx(data, name);
  throw new Error('Upload a PDF or a Word (.docx) file.');
}
