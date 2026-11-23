import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseCommand, type Command } from '../../src/commands/parse';
import { resolve, type Outcome } from '../../src/commands/run';
import { applyOp, NeedsConfirmation } from '../../src/doc/ops';
import { countWords } from '../../src/doc/segment';
import { docText, paraText, textToNodes, type Doc } from '../../src/doc/types';

const doc = (...paras: string[]): Doc => ({
  paragraphs: paras.map((text, i) => ({ id: `p${i + 1}`, nodes: textToNodes(text) })),
});
const texts = (d: Doc) => d.paragraphs.map(paraText);

// The 5-paragraph test document from the acceptance list.
const five = doc(
  'Paragraph one opens. It has two sentences.',
  'Paragraph two is short.',
  'The boat was gone. We tried again. Nobody spoke.',
  'Paragraph four here. Second of four.',
  'Paragraph five ends it.',
);

function run(said: string, d: Doc = five, ctx = { activeIndex: d.paragraphs.length - 1, wordLimit: null as number | null }) {
  const cmd = parseCommand(said);
  expect(cmd, `"${said}" should be a command`).not.toBeNull();
  return resolve(cmd!, d, ctx);
}

function edited(said: string, d: Doc = five, confirmed = false): { doc: Doc; out: Extract<Outcome, { k: 'edit' }> } {
  const out = run(said, d);
  if (out.k !== 'edit') throw new Error(`expected an edit, got ${JSON.stringify(out)}`);
  return { doc: applyOp(d, out.op, confirmed).doc, out };
}

describe('acceptance: insert between sentences 1 and 2 in paragraph 3', () => {
  it('places the text exactly there and nowhere else', () => {
    const { doc: after, out } = edited('Insert I was nervous between sentences 1 and 2 in paragraph 3');
    expect(texts(after)).toEqual([
      'Paragraph one opens. It has two sentences.',
      'Paragraph two is short.',
      'The boat was gone. I was nervous. We tried again. Nobody spoke.',
      'Paragraph four here. Second of four.',
      'Paragraph five ends it.',
    ]);
    expect(out.label).toBe('Inserting after P3·S1');
    expect(out.done).toBe('Inserted after P3·S1');
  });

  it('understands the ways Whisper may write the same command', () => {
    const expected = 'The boat was gone. I was nervous. We tried again. Nobody spoke.';
    for (const said of [
      'Insert, I was nervous, between sentences one and two in paragraph three.',
      'insert um I was nervous between sentence 1 and 2 in the third paragraph',
      'Add I was nervous after sentence one in paragraph 3',
      'Put I was nervous after the first sentence of paragraph 3.',
      'Insert I was nervous before sentence 2 in paragraph 3',
      'In paragraph 3 after sentence 1 insert I was nervous',
      'Between sentences 1 and 2 in paragraph 3, insert I was nervous.',
      'Please insert I was nervous between sentences 1 and 2 in paragraph 3',
    ]) {
      expect(texts(edited(said).doc)[2], said).toBe(expected);
    }
  });

  it('inserts only the words that were said', () => {
    const { doc: after } = edited('Insert I was nervous between sentences 1 and 2 in paragraph 3');
    const added = countWords(docText(after)) - countWords(docText(five));
    expect(added).toBe(3);
  });

  it('handles the start, the end and an empty paragraph', () => {
    expect(texts(edited('insert it was dawn at the start of paragraph 2').doc)[1]).toBe('It was dawn. Paragraph two is short.');
    expect(texts(edited('insert that was all at the end of paragraph 2').doc)[1]).toBe('Paragraph two is short. That was all.');
    expect(texts(edited('insert a first line at the start of paragraph 1', doc('')).doc)).toEqual(['A first line.']);
  });

  it('uses the paragraph being dictated into when none is named', () => {
    const out = resolve(parseCommand('insert so we waited after sentence 1')!, five, { activeIndex: 2, wordLimit: null });
    expect(out.k === 'edit' && out.label).toBe('Inserting after P3·S1');
  });

  it('refuses addresses that do not exist instead of guessing', () => {
    expect(run('insert hello between sentences 1 and 3 in paragraph 3')).toEqual({
      k: 'error', text: 'Sentences 1 and 3 are not next to each other.',
    });
    expect(run('insert hello after sentence 9 in paragraph 3')).toMatchObject({ k: 'error', text: expect.stringContaining('no sentence 9') });
    expect(run('insert hello after sentence 1 in paragraph 8')).toMatchObject({ k: 'error', text: expect.stringContaining('no paragraph 8') });
  });
});

describe('delete', () => {
  it('deletes the last sentence without asking', () => {
    const { doc: after, out } = edited('Delete the last sentence.', five);
    expect(texts(after)[4]).toBe('');
    expect(out.label).toBe('Deleting P5·S1');
    const mid = edited('delete the last sentence in paragraph 3');
    expect(texts(mid.doc)[2]).toBe('The boat was gone. We tried again.');
  });

  it('deletes a numbered or first sentence and tidies the spacing', () => {
    expect(texts(edited('remove sentence 2 in paragraph 3').doc)[2]).toBe('The boat was gone. Nobody spoke.');
    expect(texts(edited('delete the first sentence of paragraph 3').doc)[2]).toBe('We tried again. Nobody spoke.');
  });

  it('needs confirmation for more than one sentence, and for a paragraph', () => {
    const many = run('delete sentences 1 through 2 in paragraph 3');
    expect(many.k).toBe('edit');
    expect(() => applyOp(five, (many as Extract<Outcome, { k: 'edit' }>).op)).toThrow(NeedsConfirmation);
    expect(texts(edited('delete sentences 1 through 2 in paragraph 3', five, true).doc)[2]).toBe('Nobody spoke.');

    const para = run('delete paragraph 2');
    expect(() => applyOp(five, (para as Extract<Outcome, { k: 'edit' }>).op)).toThrow(NeedsConfirmation);
    expect(texts(edited('delete paragraph 2', five, true).doc)).toHaveLength(4);
  });

  it('means the last sentence written when the current paragraph is still empty', () => {
    const d = doc('First. Second.', '');
    expect(texts(edited('delete the last sentence', d).doc)).toEqual(['First.', '']);
  });
});

describe('move', () => {
  it('moves paragraph 4 above paragraph 2', () => {
    const { doc: after, out } = edited('Move paragraph 4 above paragraph 2');
    expect(texts(after).map((t) => t.slice(0, 13))).toEqual([
      'Paragraph one', 'Paragraph fou', 'Paragraph two', 'The boat was ', 'Paragraph fiv',
    ]);
    expect(out.label).toBe('Moving P4 above P2');
  });

  it('moves below, to the top, to the end, up and down', () => {
    const first = (d: Doc) => texts(d).map((t) => t.split(' ').slice(0, 2).join(' '));
    expect(first(edited('move paragraph 1 below paragraph 3').doc)).toEqual([
      'Paragraph two', 'The boat', 'Paragraph one', 'Paragraph four', 'Paragraph five',
    ]);
    expect(first(edited('move the last paragraph to the top').doc)[0]).toBe('Paragraph five');
    expect(first(edited('move paragraph 1 to the end').doc)[4]).toBe('Paragraph one');
    expect(first(edited('move paragraph 2 up').doc)[0]).toBe('Paragraph two');
    expect(first(edited('move paragraph 2 down').doc)[2]).toBe('Paragraph two');
    expect(run('move paragraph 1 up').k).toBe('error');
  });

  it('never changes the words', () => {
    const { doc: after } = edited('move paragraph 4 above paragraph 2');
    expect(countWords(docText(after))).toBe(countWords(docText(five)));
  });
});

describe('replace', () => {
  const d = doc('I was happy. Happy is not the word, unhappy either.', 'So happy.');

  it('replaces whole words in one paragraph and keeps capitals', () => {
    const { doc: after, out } = edited("Replace 'happy' with 'relieved' in paragraph 1", d);
    expect(texts(after)).toEqual(['I was relieved. Relieved is not the word, unhappy either.', 'So happy.']);
    expect(out.label).toBe('Replacing “happy” with “relieved” in P1 (2 places)');
  });

  it('replaces across the essay when no paragraph is named', () => {
    expect(texts(edited('change happy to relieved', d).doc)[1]).toBe('So relieved.');
  });

  it('treats a sentence that only looks like a replace as dictation', () => {
    expect(run('change came to my town')).toMatchObject({ k: 'error', notFound: true });
  });
});

describe('questions answered in code', () => {
  it('counts words for the essay and for one paragraph', () => {
    // 7 + 4 + 9 + 6 + 4 words in the five paragraphs.
    expect(run('word count')).toEqual({ k: 'say', text: '30 words.' });
    expect(run('How many words?')).toEqual({ k: 'say', text: '30 words.' });
    expect(run('how many words in paragraph 3')).toEqual({ k: 'say', text: 'Paragraph 3 has 9 words.' });
    expect(run('how many words are in the last paragraph')).toEqual({ k: 'say', text: 'Paragraph 5 has 4 words.' });
  });

  it('says how many words are left for the limit', () => {
    const at = (limit: number | null) => run('How many words left for this prompt?', five, { activeIndex: 0, wordLimit: limit });
    expect(at(650)).toEqual({ k: 'say', text: '620 words left of 650.' });
    expect(at(20)).toEqual({ k: 'say', text: '10 words over the limit of 20.' });
    expect(at(31)).toEqual({ k: 'say', text: '1 word left of 31.' });
    expect(at(null)).toMatchObject({ k: 'say', text: expect.stringContaining('No word limit') });
  });

  it('reads back exactly the text asked for', () => {
    expect(run('read back paragraph 2')).toEqual({ k: 'say', text: 'Paragraph two is short.', read: true });
    expect(run('read me the last sentence in paragraph 3')).toEqual({ k: 'say', text: 'Nobody spoke.', read: true });
    expect(run('read everything')).toMatchObject({ k: 'say', read: true, text: docText(five) });
  });

  it('parses undo and redo', () => {
    expect(parseCommand('Undo.')).toEqual({ k: 'undo' });
    expect(parseCommand('undo that')).toEqual({ k: 'undo' });
    // "Scratch that" now removes the last thing dictated, wherever it is.
    expect(parseCommand('scratch that')).toEqual({ k: 'deleteUtterance' });
    expect(parseCommand('redo')).toEqual({ k: 'redo' });
  });
});

describe('ordinary sentences are not commands', () => {
  it.each([
    'I had to delete the last sentence of my speech before the judges arrived.',
    'My coach told me to move on.',
    'We put the boat in the water after the storm.',
    'The word count was the least of my problems.',
    'I asked how many words she knew in Portuguese.',
    'Read the room, my mother always said.',
    'Undo is not something a kitchen has.',
    'So I went to the dock.',
  ])('%s', (sentence) => {
    expect(parseCommand(sentence)).toBeNull();
  });
});

describe('acceptance: word count matches a reference count on 5 test essays', () => {
  const dir = new URL('../fixtures/essays/', import.meta.url);
  const reference = JSON.parse(readFileSync(new URL('counts.json', dir), 'utf8')) as Record<string, number | string>;
  const files = Object.keys(reference).filter((k) => k.endsWith('.txt'));

  it('has five essays', () => expect(files).toHaveLength(5));

  it.each(files)('%s', (file) => {
    const raw = readFileSync(new URL(file, dir), 'utf8');
    // Load it the way the app holds it: one paragraph per block.
    const essay = doc(...raw.trim().split(/\n\s*\n/));
    expect(countWords(docText(essay))).toBe(reference[file]);
    expect(run('word count', essay)).toEqual({ k: 'say', text: `${reference[file]} words.` });
  });

  it('does not count a dash standing on its own as a word', () => {
    expect(countWords('It was simple — we lost.')).toBe(5);
  });
});

// Type check only: every command kind is handled by the resolver.
const _kinds: Command['k'][] = ['undo', 'redo', 'count', 'read', 'delete', 'move', 'replace', 'insert'];
void _kinds;
