import { describe, expect, it } from 'vitest';
import { DEFAULT_FORMAT, hasPaperParts, kindOf, layout, roman, type FormatProfile } from '../../src/paper/layout';
import { inferFormat, type Line } from '../../src/paper/learn';
import { readPaperUtterance } from '../../src/math/paper';
import { latexToText, toTxt } from '../../src/export';
import { countWords } from '../../src/doc/segment';
import { docText, paraText, textToNodes, type Doc } from '../../src/doc/types';

const doc = (...paras: string[]): Doc => ({ paragraphs: paras.map((text, i) => ({ id: `p${i + 1}`, nodes: textToNodes(text) })) });
const heard = (s: string) => s.split(' ').map((text) => ({ text }));

const paper = doc(
  '# Introduction',
  'A mass on a spring obeys $F = -k x$ near rest.',
  '$$\\ddot{x} = -\\omega^{2} x$$',
  '## Energy',
  '$$E = \\frac{1}{2} k x^{2}$$',
  'Figure: The spring at rest.',
  '# Results',
  '$$T = 2 \\pi \\sqrt{m/k}$$',
  'Fig: Period against mass.',
);

describe('the document model with mathematics', () => {
  it('reads inline and display mathematics from text and writes it back unchanged', () => {
    const nodes = textToNodes('Here $a + b$ and then $$c = d$$');
    expect(nodes).toEqual([
      { t: 'text', text: 'Here ' }, { t: 'math', latex: 'a + b' }, { t: 'text', text: ' and then ' }, { t: 'math', latex: 'c = d', display: true },
    ]);
    expect(paraText({ id: 'a', nodes })).toBe('Here $a + b$ and then $$c = d$$');
  });

  it('counts a formula as one word', () => {
    expect(countWords('The energy is $\\frac{1}{2} m v^{2}$ here.')).toBe(5);
    expect(countWords(docText(doc('$$\\int_{0}^{\\pi} \\sin x \\, dx$$')))).toBe(1);
  });

  it('knows what kind of block a paragraph is', () => {
    expect(paper.paragraphs.map((p) => kindOf(p.nodes))).toEqual([
      'heading1', 'para', 'equation', 'heading2', 'equation', 'caption', 'heading1', 'equation', 'caption',
    ]);
    expect(hasPaperParts(paper)).toBe(true);
    expect(hasPaperParts(doc('Just an essay.', 'With two paragraphs.'))).toBe(false);
  });
});

describe('laying a paper out in a format', () => {
  const summary = (f: FormatProfile) =>
    layout(paper, f).map((b) => (b.k === 'heading' ? `${b.number} ${b.text}`.trim() : b.k === 'equation' ? b.number : b.k === 'caption' ? `${b.label} ${b.text}` : 'para'));

  it('uses Scribe\'s default: no heading numbers, equations (1) (2) (3), "Figure 1:"', () => {
    expect(summary(DEFAULT_FORMAT)).toEqual([
      'Introduction', 'para', '(1)', 'Energy', '(2)', 'Figure 1: The spring at rest.', 'Results', '(3)', 'Figure 2: Period against mass.',
    ]);
  });

  it('applies numbered headings, section-numbered equations and "Fig. 1."', () => {
    const f: FormatProfile = {
      ...DEFAULT_FORMAT, headings: { ...DEFAULT_FORMAT.headings, numbering: 'arabic', dot: true },
      equations: { numbered: true, style: 'section' }, captions: { label: 'Fig.', separator: '.' },
    };
    expect(summary(f)).toEqual([
      '1. Introduction', 'para', '(1.1)', '1.1. Energy', '(1.2)', 'Fig. 1. The spring at rest.', '2. Results', '(2.1)', 'Fig. 2. Period against mass.',
    ]);
  });

  it('applies roman headings in capitals with lettered subsections, and unnumbered equations', () => {
    const f: FormatProfile = {
      ...DEFAULT_FORMAT, headings: { ...DEFAULT_FORMAT.headings, numbering: 'roman', caps: true }, equations: { numbered: false, style: 'plain' },
      captions: { label: 'FIG.', separator: '.' },
    };
    expect(summary(f).slice(0, 5)).toEqual(['I. INTRODUCTION', 'para', '', 'A. Energy', '']);
    expect(roman(4)).toBe('IV');
    expect(roman(9)).toBe('IX');
  });

  it('never changes the words of the essay', () => {
    const before = JSON.stringify(paper);
    layout(paper, { ...DEFAULT_FORMAT, headings: { ...DEFAULT_FORMAT.headings, caps: true } });
    expect(JSON.stringify(paper)).toBe(before);
  });
});

describe('learning a format from a sample\'s lines', () => {
  const bodyLine = (y: number, text = 'The measured period agrees with the prediction to within two percent across all five masses used.'): Line => ({ text, sizePt: 10, bold: false, x: 72, y, page: 1 });
  const sample: Line[] = [
    { text: 'Oscillations of a Loaded Spring', sizePt: 18, bold: true, x: 150, y: 80, page: 1 },
    { text: 'I. INTRODUCTION', sizePt: 11, bold: true, x: 72, y: 130, page: 1 },
    bodyLine(150), bodyLine(162), bodyLine(174), bodyLine(186),
    { text: 'x(t) = A cos(ωt + φ) (1)', sizePt: 10, bold: false, x: 200, y: 210, page: 1 },
    bodyLine(234), bodyLine(246),
    { text: 'FIG. 1. The apparatus used for the measurements.', sizePt: 9, bold: false, x: 90, y: 300, page: 1 },
    { text: 'II. METHOD', sizePt: 11, bold: true, x: 72, y: 330, page: 1 },
    bodyLine(350), bodyLine(362), bodyLine(374),
    { text: 'T = 2π√(m/k) (2)', sizePt: 10, bold: false, x: 210, y: 400, page: 1 },
    { text: 'FIG. 2. Period against mass.', sizePt: 9, bold: false, x: 90, y: 470, page: 1 },
    { text: 'III. RESULTS', sizePt: 11, bold: true, x: 72, y: 500, page: 1 },
    bodyLine(520), bodyLine(532),
  ];

  it('reads a physics-journal style', () => {
    const f = inferFormat(sample, { widthPt: 612, fontFamily: 'Times-Roman serif' }, 'journal');
    expect(f.name).toBe('journal');
    expect(f.body).toEqual({ font: 'serif', sizePt: 10, lineSpacing: 1 });
    expect(f.page).toEqual({ size: 'letter', marginIn: 1 });
    expect(f.headings).toMatchObject({ numbering: 'roman', caps: true, bold: true, sizePt: 11 });
    expect(f.equations).toEqual({ numbered: true, style: 'plain' });
    expect(f.captions).toEqual({ label: 'FIG.', separator: '.' });
    expect(f.notes.join(' ')).toContain('roman numerals');
  });

  it('reads a report style: numbered headings, "Figure 1:", section equation numbers, A4, sans-serif, double spacing', () => {
    const report: Line[] = [
      { text: '1. Introduction', sizePt: 14, bold: true, x: 85, page: 1 },
      { ...bodyLine(0), sizePt: 12, x: 85, y: undefined }, { ...bodyLine(0), sizePt: 12, x: 85, y: undefined }, { ...bodyLine(0), sizePt: 12, x: 85, y: undefined },
      { text: 'E = mc² (1.1)', sizePt: 12, bold: false, x: 85, page: 1 },
      { text: 'Figure 1: Layout of the track.', sizePt: 11, bold: false, x: 85, page: 1 },
      { text: '2. Method', sizePt: 14, bold: true, x: 85, page: 1 },
      { text: '2.1 Apparatus', sizePt: 12, bold: true, x: 85, page: 1 },
      { ...bodyLine(0), sizePt: 12, x: 85, y: undefined },
      { text: 'v = d/t (2.1)', sizePt: 12, bold: false, x: 85, page: 1 },
    ];
    const f = inferFormat(report, { widthPt: 595, marginLeftPt: 85, lineSpacing: 2, fontFamily: 'Calibri' }, 'report');
    expect(f.page.size).toBe('a4');
    expect(f.body).toEqual({ font: 'sans', sizePt: 12, lineSpacing: 2 });
    expect(f.headings).toMatchObject({ numbering: 'arabic', dot: true, caps: false, sizePt: 14 });
    expect(f.equations).toEqual({ numbered: true, style: 'section' });
    expect(f.captions).toEqual({ label: 'Figure', separator: ':' });
  });

  it('says what it could not find instead of guessing', () => {
    const plain = Array.from({ length: 8 }, (_, i) => bodyLine(100 + i * 12));
    const f = inferFormat(plain, { widthPt: 612 }, 'plain');
    expect(f.equations.numbered).toBe(false);
    expect(f.notes).toContain('No numbered equations were found, so equations are not numbered.');
    expect(f.notes).toContain('No figure captions were found; “Figure 1:” is used.');
    expect(f.notes).toContain('No section headings were found; the default heading style is used.');
    expect(inferFormat([], { widthPt: 612 }, 'empty').notes[0]).toContain('too little readable text');
  });

  it('keeps none of the sample\'s text', () => {
    const f = inferFormat(sample, { widthPt: 612 }, 'journal');
    expect(JSON.stringify(f)).not.toContain('apparatus');
    expect(JSON.stringify(f)).not.toContain('measured period');
  });
});

describe('math mode: what an utterance becomes', () => {
  it('writes a wholly mathematical utterance as mathematics', () => {
    expect(readPaperUtterance(heard('x squared over two'), true, false)).toEqual({ k: 'inline', pieces: [{ t: 'math', latex: 'x^{2}/2' }] });
  });

  it('leaves ordinary sentences to normal dictation', () => {
    expect(readPaperUtterance(heard('So I went to the dock.'), true, false)).toBeNull();
    expect(readPaperUtterance(heard('We measured the period five times.'), true, false)).toBeNull();
  });

  it('makes a numbered equation, a heading, a subheading and a caption on request', () => {
    expect(readPaperUtterance(heard('Equation integral from zero to pi of sine x dx.'), true, false)).toEqual({
      k: 'block', nodes: [{ t: 'math', latex: '\\int_{0}^{\\pi} \\sin x \\, dx', display: true }],
    });
    expect(readPaperUtterance(heard('new heading um Results and discussion.'), true, false)).toEqual({ k: 'block', nodes: [{ t: 'text', text: '# Results and discussion' }] });
    expect(readPaperUtterance(heard('subheading apparatus'), true, false)).toEqual({ k: 'block', nodes: [{ t: 'text', text: '## Apparatus' }] });
    expect(readPaperUtterance(heard('figure caption the spring at rest'), true, false)).toEqual({ k: 'block', nodes: [{ t: 'text', text: 'Figure: The spring at rest.' }] });
  });

  it('sets mathematics inside a sentence between "math" and "end math"', () => {
    const r = readPaperUtterance(heard('the kinetic energy is math one half m v squared end math at the bottom'), true, false);
    expect(r?.k).toBe('inline');
    const text = (r as { pieces: { t: string; text?: string; latex?: string }[] }).pieces.map((p) => (p.t === 'math' ? `$${p.latex}$` : p.text)).join('');
    expect(text).toBe('The kinetic energy is $\\frac{1}{2} m v^{2}$ at the bottom.');
  });
});

describe('writing mathematics on one line for formats without typesetting', () => {
  it.each([
    ['x^{2}/2', 'x²/2'],
    ['\\int_{0}^{\\pi} \\sin x \\, dx', '∫₀^(π) sin x dx'],
    ['\\frac{1}{2} m v^{2}', '1/2 m v²'],
    ['\\frac{a + b}{c}', '(a + b)/c'],
    ['E = m c^{2}', 'E = m c²'],
    ['\\ddot{x} = -\\omega^{2} x', 'ẍ = -ω² x'],
    ['9.8\\,\\mathrm{m/s^{2}}', '9.8 m/s²'],
    ['T = 2 \\pi \\sqrt{m/k}', 'T = 2 π √(m/k)'],
    ['\\sum_{i = 1}^{n} i^{2}', '∑_(i = 1)ⁿ i²'],
    ['x \\leq 5', 'x ≤ 5'],
  ])('%s', (latex, expected) => expect(latexToText(latex).normalize('NFC')).toBe(expected.normalize('NFC')));
});

describe('plain-text export', () => {
  it('leaves an ordinary essay exactly as typed', () => {
    expect(toTxt(doc('First one.', 'Second one.'))).toBe('First one.\n\nSecond one.\n');
  });

  it('writes a paper in the chosen format', () => {
    const f: FormatProfile = { ...DEFAULT_FORMAT, headings: { ...DEFAULT_FORMAT.headings, numbering: 'arabic', dot: true }, captions: { label: 'Fig.', separator: '.' } };
    expect(toTxt(paper, f).split('\n\n').slice(0, 6)).toEqual([
      '1. Introduction',
      'A mass on a spring obeys F = -k x near rest.',
      '    ẍ = -ω² x    (1)'.normalize('NFC'),
      '1.1. Energy',
      '    E = 1/2 k x²    (2)',
      'Fig. 1. The spring at rest.',
    ].map((s) => s.normalize('NFC')));
  });
});
