import { describe, expect, it } from 'vitest';
import { countWords, sentences } from '../../src/doc/segment';
import {
  applyOp, deletionImpact, mergeWithPrevious, NeedsConfirmation, OpError, setText, splitParagraph,
  type Op,
} from '../../src/doc/ops';
import { docText, paraText, textToNodes, type Doc } from '../../src/doc/types';

const doc = (...paras: string[]): Doc => ({
  paragraphs: paras.map((text, i) => ({ id: `p${i + 1}`, nodes: textToNodes(text) })),
});
const texts = (d: Doc) => d.paragraphs.map(paraText);

describe('sentences', () => {
  it('splits on sentence ends and keeps offsets', () => {
    const text = 'I went to the dock. The boat was gone! Why?';
    const s = sentences(text);
    expect(s.map((x) => x.text)).toEqual(['I went to the dock.', 'The boat was gone!', 'Why?']);
    for (const x of s) expect(text.slice(x.start, x.end)).toBe(x.text);
  });

  it('does not split after abbreviations or initials', () => {
    expect(sentences('Dr. Lee met Mr. Park at 9 a.m. sharp. They talked.').map((x) => x.text)).toEqual([
      'Dr. Lee met Mr. Park at 9 a.m. sharp.',
      'They talked.',
    ]);
    expect(sentences('I read J. K. Rowling. It was long.')).toHaveLength(2);
  });

  it('returns nothing for blank text', () => {
    expect(sentences('   ')).toEqual([]);
  });
});

describe('countWords', () => {
  it('counts contractions, hyphenated words and numbers once each', () => {
    expect(countWords("I don't like well-known shortcuts, not 3.5 of them.")).toBe(9);
    expect(countWords('')).toBe(0);
    expect(countWords('  one   two\n\nthree — four…')).toBe(4);
  });
});

describe('operations', () => {
  const base = doc('One. Two.', 'Three.', 'Four. Five. Six.');
  const cases: [string, Op][] = [
    ['insertParagraph', { k: 'insertParagraph', index: 1, para: { id: 'x', nodes: textToNodes('New.') } }],
    ['setParagraph', setText(0, 'One. Two. And more.')],
    ['moveParagraph', { k: 'moveParagraph', from: 2, to: 0 }],
    ['split', splitParagraph(2, 'Four. Five. Six.', 6, { id: 'y', nodes: [] })],
    ['merge', mergeWithPrevious(base, 1, 'Three.').op],
    ['replaceDoc', { k: 'replaceDoc', doc: doc('Entirely different.') }],
    ['deleteParagraph', { k: 'deleteParagraph', index: 1 }],
  ];

  it.each(cases)('%s followed by its inverse restores the document exactly', (_name, op) => {
    const { doc: changed, inverse } = applyOp(base, op, true);
    expect(changed).not.toEqual(base);
    expect(applyOp(changed, inverse, true).doc).toEqual(base);
  });

  it('never mutates the document it is given', () => {
    const frozen = structuredClone(base);
    for (const [, op] of cases) applyOp(base, op, true);
    expect(base).toEqual(frozen);
  });

  it('splits and merges at the right place', () => {
    const split = applyOp(base, splitParagraph(2, 'Four. Five. Six.', 6, { id: 'y', nodes: [] })).doc;
    expect(texts(split)).toEqual(['One. Two.', 'Three.', 'Four.', 'Five. Six.']);
    const { op, caret } = mergeWithPrevious(split, 3, 'Five. Six.');
    expect(texts(applyOp(split, op).doc)).toEqual(texts(base));
    expect(caret).toBe('Four. '.length);
  });

  it('rejects paragraphs that do not exist and refuses to leave an essay with none', () => {
    expect(() => applyOp(base, { k: 'deleteParagraph', index: 9 }, true)).toThrow(OpError);
    expect(() => applyOp(doc('Only.'), { k: 'deleteParagraph', index: 0 }, true)).toThrow(OpError);
  });
});

describe('deletion guard', () => {
  const base = doc('One. Two. Three.', 'Four.', 'Five. Six.');

  it('lets a single sentence be removed without asking', () => {
    expect(texts(applyOp(base, setText(0, 'One. Three.')).doc)[0]).toBe('One. Three.');
  });

  it('lets a sentence be rewritten without asking', () => {
    expect(() => applyOp(base, setText(0, 'One. Two, changed a lot. Three.'))).not.toThrow();
  });

  it('asks before removing more than one sentence, and says exactly which', () => {
    try {
      applyOp(base, setText(0, 'One.'));
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(NeedsConfirmation);
      expect((err as NeedsConfirmation).removed).toEqual(['Two.', 'Three.']);
    }
  });

  it('asks before removing a paragraph, even a one-sentence one', () => {
    expect(() => applyOp(base, { k: 'deleteParagraph', index: 1 })).toThrow(NeedsConfirmation);
  });

  it('asks before replacing the essay with a shorter one', () => {
    expect(() => applyOp(base, { k: 'replaceDoc', doc: doc('One.') })).toThrow(NeedsConfirmation);
  });

  it('applies the same change once confirmed', () => {
    const after = applyOp(base, { k: 'deleteParagraph', index: 1 }, true).doc;
    expect(texts(after)).toEqual(['One. Two. Three.', 'Five. Six.']);
  });

  it('does not ask for moves, merges, splits or deleting an empty paragraph', () => {
    expect(deletionImpact(base, applyOp(base, { k: 'moveParagraph', from: 0, to: 2 }).doc).large).toBe(false);
    expect(() => applyOp(base, mergeWithPrevious(base, 1, 'Four.').op)).not.toThrow();
    expect(() => applyOp(doc('no full stop', 'then more.'), mergeWithPrevious(doc('no full stop', 'then more.'), 1, 'then more.').op)).not.toThrow();
    expect(() => applyOp(doc('One.', ''), { k: 'deleteParagraph', index: 1 })).not.toThrow();
  });
});

describe('text and math nodes', () => {
  it('round-trips math written between dollar signs', () => {
    const nodes = textToNodes('Energy is $E=mc^2$ here.');
    expect(nodes).toEqual([
      { t: 'text', text: 'Energy is ' },
      { t: 'math', latex: 'E=mc^2' },
      { t: 'text', text: ' here.' },
    ]);
    expect(paraText({ id: 'a', nodes })).toBe('Energy is $E=mc^2$ here.');
    expect(docText(doc('A.', 'B.'))).toBe('A.\n\nB.');
  });
});
