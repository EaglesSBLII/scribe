import { describe, expect, it } from 'vitest';
import { parseCommand } from '../../src/commands/parse';
import { removeSegment, resolve, type Outcome } from '../../src/commands/run';
import { fromJson } from '../../src/commands/fromJson';
import type { RequestJson } from '../../src/llm/assist';
import { applyOp, NeedsConfirmation } from '../../src/doc/ops';
import { countWords } from '../../src/doc/segment';
import { docText, paraText, textToNodes, type Doc } from '../../src/doc/types';

const doc = (...paras: string[]): Doc => ({ paragraphs: paras.map((text, i) => ({ id: `p${i + 1}`, nodes: textToNodes(text) })) });
const texts = (d: Doc) => d.paragraphs.map(paraText);
const base = doc('The boat was gone. We tried again.', 'Nobody spoke on the dock that morning.');
const ctx = { activeIndex: 1, wordLimit: null, cursor: null };
const edit = (out: Outcome) => {
  if (out.k !== 'edit') throw new Error(`expected an edit, got ${JSON.stringify(out)}`);
  return out;
};

describe('new spoken commands are recognised', () => {
  it.each([
    ['Delete what I just said.', { k: 'deleteUtterance' }],
    ['scratch that', { k: 'deleteUtterance' }],
    ['Delete that.', { k: 'deleteUtterance' }],
    ['delete the last 5 words', { k: 'deleteWords', count: 5 }],
    ['Delete the last five words.', { k: 'deleteWords', count: 5 }],
    ['delete the last word', { k: 'deleteWords', count: 1 }],
    ['undo that', { k: 'undo' }],
    ['move this paragraph up', { k: 'move', para: 'current', where: 'up' }],
    ['Go back to the sentence about the boat.', { k: 'goto', about: 'the boat' }],
    ['go to the end', { k: 'gotoEnd' }],
    ['coach mode', { k: 'mode', mode: 'coach' }],
    ['Switch to conversation mode.', { k: 'mode', mode: 'conversation' }],
    ['draft mode', { k: 'mode', mode: 'draft' }],
    ['How many words do I have?', { k: 'count', scope: 'essay' }],
    ['read back the last paragraph', { k: 'read', what: 'paragraph', para: 'last' }],
  ])('%s', (said, expected) => expect(parseCommand(said)).toEqual(expected));

  it('does not mistake ordinary sentences for them', () => {
    for (const s of ['I deleted the last five words of my speech.', 'We went back to the dock.', 'That was the coach mode of thinking.', 'Scratch that itch, my coach said.']) {
      expect(parseCommand(s), s).toBeNull();
    }
  });
});

describe('acceptance: "delete the last 5 words" removes exactly 5 words', () => {
  it('takes exactly five words from the end of where the writer is', () => {
    const out = edit(resolve({ k: 'deleteWords', count: 5 }, base, ctx));
    const after = applyOp(base, out.op).doc;
    expect(texts(after)).toEqual(['The boat was gone. We tried again.', 'Nobody spoke']);
    expect(countWords(docText(base)) - countWords(docText(after))).toBe(5);
    expect(out.label).toBe('Deleting the last 5 words of P2');
    // Undo restores it exactly.
    expect(applyOp(after, applyOp(base, out.op).inverse, true).doc).toEqual(base);
  });

  it('deletes one word, and counts words the way the word count does', () => {
    const d = doc('It was a well-known, 3.5-mile shortcut — honestly.');
    const one = applyOp(d, edit(resolve({ k: 'deleteWords', count: 1 }, d, { ...ctx, activeIndex: 0 })).op).doc;
    expect(texts(one)).toEqual(['It was a well-known, 3.5-mile shortcut —']);
    const three = applyOp(d, edit(resolve({ k: 'deleteWords', count: 3 }, d, { ...ctx, activeIndex: 0 })).op).doc;
    expect(texts(three)).toEqual(['It was a well-known,']);
    expect(countWords(docText(d)) - countWords(docText(three))).toBe(3);
  });

  it('refuses more words than are there, rather than reaching into another paragraph', () => {
    expect(resolve({ k: 'deleteWords', count: 12 }, base, ctx)).toEqual({ k: 'error', text: 'There are only 7 words there, in paragraph 2.' });
  });

  it('asks which words are meant when the writer has gone back to an earlier sentence, and never guesses', () => {
    const out = resolve({ k: 'deleteWords', count: 2 }, base, { ...ctx, cursor: { index: 0, sentence: 0 } });
    expect(out.k).toBe('ask');
    if (out.k !== 'ask') return;
    expect(out.question).toBe('The last 2 words before where you are in paragraph 1, or the last 2 words of the essay?');
    const here = applyOp(base, edit(resolve(out.choices[0].cmd, base, { ...ctx, cursor: { index: 0, sentence: 0 } })).op).doc;
    expect(texts(here)[0]).toBe('The boat We tried again.');
    const end = applyOp(base, edit(resolve(out.choices[1].cmd, base, { ...ctx, cursor: { index: 0, sentence: 0 } })).op).doc;
    expect(texts(end)[1]).toBe('Nobody spoke on the dock');
  });
});

describe('acceptance: "delete what I just said" removes exactly the last utterance', () => {
  it('removes the utterance and nothing else, and undo restores it', () => {
    const out = edit(removeSegment(base, [{ paraId: 'p1', text: 'We tried again.' }]));
    const after = applyOp(base, out.op).doc;
    expect(texts(after)).toEqual(['The boat was gone.', 'Nobody spoke on the dock that morning.']);
    expect(applyOp(after, applyOp(base, out.op).inverse, true).doc).toEqual(base);
  });

  it('removes an utterance at the start of a paragraph without leaving a stray space', () => {
    const after = applyOp(base, edit(removeSegment(base, [{ paraId: 'p1', text: 'The boat was gone.' }])).op).doc;
    expect(texts(after)[0]).toBe('We tried again.');
  });

  it('removes the latest occurrence when the same words were said twice', () => {
    const d = doc('We waited. So we waited. We waited.');
    expect(texts(applyOp(d, edit(removeSegment(d, [{ paraId: 'p1', text: 'We waited.' }])).op).doc)).toEqual(['We waited. So we waited.']);
  });

  it('removes an utterance that started a new paragraph, along with that paragraph', () => {
    const d = doc('First thought.', 'A fresh start.');
    const out = edit(removeSegment(d, [{ paraId: 'p1', text: 'First thought.' }, { paraId: 'p2', text: 'A fresh start.' }]));
    // Two sentences and a paragraph: this needs confirmation like any large deletion.
    expect(() => applyOp(d, out.op)).toThrow(NeedsConfirmation);
    expect(texts(applyOp(d, out.op, true).doc)).toEqual(['']);
  });

  it('leaves the essay alone if the words have since been edited', () => {
    expect(removeSegment(base, [{ paraId: 'p1', text: 'We tried once more.' }])).toMatchObject({ k: 'error' });
    expect(removeSegment(base, [{ paraId: 'gone', text: 'We tried again.' }])).toMatchObject({ k: 'error' });
  });
});

describe('the model\'s structured reading of a request is checked in code', () => {
  const json = (over: { op: RequestJson['op']; target?: Partial<RequestJson['target']>; args?: Partial<RequestJson['args']> }): RequestJson => ({
    op: over.op,
    target: { unit: 'none', paragraph: 0, sentence: 0, to_sentence: 0, count: 0, ...over.target },
    args: { place: 'none', other_paragraph: 0, text: '', find: '', with: '', what: 'none', ...over.args },
  });

  it('turns valid readings into commands', () => {
    expect(fromJson(json({ op: 'delete', target: { unit: 'sentence', sentence: 2 } }), 'take out the second sentence')).toEqual({ k: 'delete', what: 'sentences', from: 2, to: undefined, para: undefined });
    expect(fromJson(json({ op: 'delete', target: { unit: 'utterance' } }), 'get rid of what I just said')).toEqual({ k: 'deleteUtterance' });
    expect(fromJson(json({ op: 'delete', target: { unit: 'words', count: 3 } }), 'lose the last three words')).toEqual({ k: 'deleteWords', count: 3 });
    expect(fromJson(json({ op: 'move', target: { unit: 'paragraph', paragraph: 4 }, args: { place: 'above', other_paragraph: 2 } }), 'put paragraph four on top of two')).toEqual({ k: 'move', para: 4, where: 'above', target: 2 });
    expect(fromJson(json({ op: 'replace', target: { unit: 'paragraph', paragraph: 1 }, args: { find: 'happy', with: 'relieved' } }), 'swap the word happy for relieved in paragraph one')).toEqual({ k: 'replace', find: 'happy', with: 'relieved', para: 1 });
    expect(fromJson(json({ op: 'goto', args: { text: 'my grandfather' } }), 'take me to the bit about my grandfather')).toEqual({ k: 'goto', about: 'my grandfather' });
    expect(fromJson(json({ op: 'count', args: { what: 'left' } }), 'how much room do I have')).toEqual({ k: 'count', scope: 'left' });
  });

  it('rejects any words the speaker did not say', () => {
    // The model tries to insert its own sentence.
    expect(fromJson(json({ op: 'insert', target: { sentence: 1 }, args: { place: 'after', text: 'It was the best day of my life' } }), 'add something nice after sentence one')).toBeNull();
    // The model invents a replacement word.
    expect(fromJson(json({ op: 'replace', args: { find: 'happy', with: 'overjoyed' } }), 'change happy to something better')).toBeNull();
    // The speaker's own words are fine.
    expect(fromJson(json({ op: 'insert', target: { sentence: 1 }, args: { place: 'after', text: 'I was nervous' } }), 'after the first sentence put I was nervous')).toMatchObject({ k: 'insert', at: { k: 'after', sent: 1 } });
  });

  it('treats a question or anything unclear as not a command', () => {
    expect(fromJson(json({ op: 'none' }), 'is my opening too slow')).toBeNull();
    expect(fromJson(json({ op: 'delete', target: { unit: 'words', count: 0 } }), 'delete some words')).toBeNull();
    expect(fromJson(json({ op: 'move', target: { paragraph: 2 } }), 'move paragraph two somewhere')).toBeNull();
    expect(fromJson({ op: 'delete' } as RequestJson, 'delete')).toBeNull();
  });
});
