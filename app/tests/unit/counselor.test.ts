import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { asksForWriting, isVerbatim, looksDrafted, splitQuotes } from '../../src/llm/guard';
import { numberedEssay } from '../../src/llm/prompts';
import { looksLikeEditRequest } from '../../src/llm/assist';
import { locate, mechanicalChecks } from '../../src/checks';
import { fileName, toTxt } from '../../src/export';
import { textToNodes, type Doc } from '../../src/doc/types';

const doc = (...paras: string[]): Doc => ({
  paragraphs: paras.map((text, i) => ({ id: `p${i + 1}`, nodes: textToNodes(text) })),
});
const essay = 'The summer I turned sixteen, I rebuilt a boat engine with my grandfather. It did not start. He laughed.';

describe('the counselor cannot reach the essay', () => {
  const dir = new URL('../../src/llm/', import.meta.url);
  const files = readdirSync(dir).filter((f) => f.endsWith('.ts'));

  it('has files to check', () => expect(files.length).toBeGreaterThanOrEqual(4));

  it.each(files)('%s imports nothing that can edit an essay', (file) => {
    const source = readFileSync(new URL(file, dir), 'utf8');
    const imports = [...source.matchAll(/from\s+'([^']+)'/g)].map((m) => m[1]);
    // The store and the operation layer are the only ways to change an essay.
    expect(imports.filter((i) => /(^|\/)store$|doc\/ops$|editorBus$|commands\//.test(i))).toEqual([]);
    // And it never touches the essay tables directly.
    expect(source).not.toMatch(/db\.(essays|ops|versions)\b/);
  });
});

describe('spotting a request to write the essay', () => {
  it.each([
    'Can you write my essay for me?',
    'write me an intro paragraph',
    'Could you rewrite the second sentence',
    'just draft the conclusion',
    'give me an opening',
    'Please polish this paragraph',
  ])('%s', (m) => expect(asksForWriting(m)).toBe(true));

  it.each([
    'What do you think about this?',
    'What should I include?',
    'Does this answer the prompt?',
    'Is my opening too slow?',
    'I wrote this last night, is it any good?',
  ])('not: %s', (m) => expect(asksForWriting(m)).toBe(false));
});

describe('checking a reply for drafted essay text', () => {
  it('accepts advice that quotes the student', () => {
    const reply = 'Your opening works: "It did not start" (P1·S2) is short and concrete. I\'d cut nothing there. What did your grandfather say next?';
    expect(looksDrafted(reply, essay).drafted).toBe(false);
  });

  it('accepts a short example phrase', () => {
    expect(looksDrafted('You could name the sound, for example "the rope snapping back".', essay).drafted).toBe(false);
  });

  it('rejects a long passage that is not the student\'s words', () => {
    const reply = 'Try this: "Growing up on the water taught me that failure is only the first draft of success, and that every broken engine holds a lesson about patience, family and the quiet dignity of trying again."';
    expect(looksDrafted(reply, essay)).toMatchObject({ drafted: true });
  });

  it('rejects a run of first-person story sentences', () => {
    const reply = 'Here is a version. I spent eleven days in the garage with my grandfather. My hands were black with grease by the end. We pulled the cord together and nothing happened.';
    expect(looksDrafted(reply, essay)).toMatchObject({ drafted: true });
  });

  it('does not mistake the counselor talking about itself for a draft', () => {
    const reply = "I think the second line is your best. I'd keep it exactly as it is. I wonder whether the laugh needs a reason. I like that nothing is explained.";
    expect(looksDrafted(reply, essay).drafted).toBe(false);
  });
});

describe('quotes', () => {
  it('marks which quotes are the student\'s own words', () => {
    const parts = splitQuotes('I like “It did not start.” more than "a tale of perseverance".', essay);
    expect(parts.filter((p) => typeof p !== 'string')).toEqual([
      { text: 'It did not start.', yours: true },
      { text: 'a tale of perseverance', yours: false },
    ]);
  });

  it('checks a quote word for word, ignoring case and quote style', () => {
    expect(isVerbatim('it did not start', essay)).toBe(true);
    expect(isVerbatim('It never started', essay)).toBe(false);
    expect(isVerbatim('', essay)).toBe(false);
  });
});

describe('what the model is shown', () => {
  it('labels every sentence with its address', () => {
    expect(numberedEssay(doc('One. Two.', 'Three.'))).toBe('[P1·S1] One.\n[P1·S2] Two.\n[P2·S1] Three.');
    expect(numberedEssay(doc(''))).toContain('empty');
  });
});

describe('edit requests in other words', () => {
  it('only sends likely edit requests to the model', () => {
    expect(looksLikeEditRequest('Take out the second sentence in paragraph two')).toBe(true);
    expect(looksLikeEditRequest('Could you swap paragraphs one and three')).toBe(true);
    expect(looksLikeEditRequest('I rebuilt a boat engine with my grandfather')).toBe(false);
    expect(looksLikeEditRequest('The last sentence of his letter stayed with me')).toBe(false);
    expect(looksLikeEditRequest('Move on')).toBe(false);
  });
});

describe('final checks done in code', () => {
  it('reports the word limit either way', () => {
    expect(mechanicalChecks(doc('One two three.'), 650)[0]).toEqual({ level: 'ok', text: '3 words, within the 650-word limit (647 to spare).' });
    expect(mechanicalChecks(doc('One two three.'), 2)[0]).toEqual({ level: 'warn', text: '3 words: 1 over the 2-word limit.' });
    expect(mechanicalChecks(doc('One two three.'), null)[0].level).toBe('warn');
  });

  it('flags mechanical slips with their location and changes nothing', () => {
    const d = doc('We went to the the dock. it was cold.', 'No ending here', '');
    const before = JSON.stringify(d);
    const found = mechanicalChecks(d, 650).slice(1);
    expect(found).toEqual([
      { level: 'warn', text: 'A sentence may start without a capital: “it was cold”', where: 'P1' },
      { level: 'warn', text: 'The word “the” is repeated.', where: 'P1·S1' },
      { level: 'warn', text: 'The paragraph does not end with a period, question mark or exclamation point.', where: 'P2·S1' },
      { level: 'warn', text: 'This paragraph is empty.', where: 'P3' },
    ]);
    expect(JSON.stringify(d)).toBe(before);
  });

  it('counts highlights that still need a decision', () => {
    const d: Doc = { paragraphs: [{ id: 'a', nodes: [{ t: 'text', text: 'Boats' }, { t: 'flag', text: '.', alt: ' period' }] }] };
    expect(mechanicalChecks(d, 650).at(-1)?.text).toContain('1 highlighted word still needs a decision');
  });

  it('finds where a quoted line is', () => {
    expect(locate(doc('One. Two here.', 'Three.'), 'two here')).toBe('P1·S2');
    expect(locate(doc('One.'), 'missing')).toBeUndefined();
  });
});

describe('export', () => {
  it('writes the essay text exactly, one blank line between paragraphs', () => {
    expect(toTxt(doc('First one.', '', 'Second — with “quotes”.'))).toBe('First one.\n\nSecond — with “quotes”.\n');
    expect(fileName('Common App: "Why?"', 'docx')).toBe('Common App Why.docx');
    expect(fileName('  ', 'pdf')).toBe('Essay.pdf');
  });
});
