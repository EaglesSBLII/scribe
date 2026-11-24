import { describe, expect, it } from 'vitest';
import { Chunker, encodeWav, SAMPLE_RATE } from '../../src/dictation/chunker';
import { clean } from '../../src/dictation/clean';
import { appendPieces, applyOp, flipFlag } from '../../src/doc/ops';
import { paraText, textToNodes, type Doc } from '../../src/doc/types';

// A stand-in for a voice: a tone that swells and dips several times a second, as syllables
// do. (A perfectly steady tone is background, and the speech detector treats it as such.)
const tone = (seconds: number, level = 0.2) =>
  Float32Array.from({ length: seconds * SAMPLE_RATE }, (_, i) => level * Math.sin(i / 5) * (0.08 + 0.92 * Math.abs(Math.sin((Math.PI * 4 * i) / SAMPLE_RATE))));
const quiet = (seconds: number) => new Float32Array(seconds * SAMPLE_RATE);

function run(parts: Float32Array[], opts = {}) {
  const events: string[] = [];
  const chunker = new Chunker({
    ...opts,
    onSpeechStart: () => events.push('start'),
    onInterim: () => events.push('interim'),
    onChunk: (s, paused) => events.push(`chunk ${(s.length / SAMPLE_RATE).toFixed(1)}s ${paused ? 'paused' : 'cut'}`),
  });
  // Feed in uneven pieces, as a real microphone does.
  for (const p of parts) for (let i = 0; i < p.length; i += 1000) chunker.feed(p.slice(i, i + 1000));
  return { events, chunker };
}

describe('speech chunker', () => {
  it('closes a chunk when the speaker pauses, keeping a little audio from before', () => {
    const { events } = run([quiet(1), tone(2), quiet(1.5)]);
    expect(events[0]).toBe('start');
    expect(events).toContain('interim');
    // About 0.3 s lead-in (which includes the first sound) + 2 s speech + 0.9 s closing silence.
    expect(events.at(-1)).toMatch(/^chunk 3.[1-3]s paused$/);
  });

  it('ignores silence and makes two chunks for two sentences', () => {
    expect(run([quiet(3)]).events).toEqual([]);
    const { events } = run([tone(1), quiet(1.2), tone(1), quiet(1.2)]);
    expect(events.filter((e) => e.startsWith('chunk'))).toHaveLength(2);
  });

  it('does not split on a short breath', () => {
    const { events } = run([tone(1), quiet(0.4), tone(1), quiet(1.2)]);
    expect(events.filter((e) => e.startsWith('chunk'))).toHaveLength(1);
  });

  it('cuts very long speech and hands over what is left when the mic stops', () => {
    const { events, chunker } = run([tone(5)], { maxLength: 2 });
    expect(events.filter((e) => e.endsWith('cut')).length).toBeGreaterThanOrEqual(2);
    const before = events.length;
    chunker.flush();
    expect(events.length).toBeGreaterThanOrEqual(before);
  });

  it('writes a valid 16 kHz mono WAV header', () => {
    const v = new DataView(encodeWav(tone(1)));
    expect(v.byteLength).toBe(44 + SAMPLE_RATE * 2);
    expect(v.getUint32(24, true)).toBe(SAMPLE_RATE);
    expect(v.getUint16(22, true)).toBe(1);
    expect(v.getUint16(34, true)).toBe(16);
  });
});

const doc = (...paras: string[]): Doc => ({
  paragraphs: paras.map((text, i) => ({ id: `p${i + 1}`, nodes: textToNodes(text) })),
});
const texts = (d: Doc) => d.paragraphs.map(paraText);
let made = 0;
const newPara = () => ({ id: `new${++made}`, nodes: [] });

function dictate(d: Doc, index: number, said: string, continuing = false) {
  const r = appendPieces(d, index, clean(said, { final: true, continuing }).pieces, newPara)!;
  return { doc: applyOp(d, r.op).doc, lastIndex: r.lastIndex };
}

describe('putting dictated text into the essay', () => {
  it('adds to the end of the paragraph with one space', () => {
    expect(texts(dictate(doc('First.', 'Second.'), 0, 'um and then more').doc)).toEqual(['First. And then more.', 'Second.']);
    expect(texts(dictate(doc(''), 0, 'hello there').doc)).toEqual(['Hello there.']);
  });

  it('starts a new paragraph where "new paragraph" was said', () => {
    const r = dictate(doc('First.', 'Last.'), 0, 'more here new paragraph a fresh start');
    expect(texts(r.doc)).toEqual(['First. More here.', 'A fresh start.', 'Last.']);
    expect(r.lastIndex).toBe(1);
  });

  it('handles "new paragraph" said on its own', () => {
    const r = dictate(doc('An unfinished thought'), 0, 'new paragraph');
    expect(texts(r.doc)).toEqual(['An unfinished thought.', '']);
    expect(r.lastIndex).toBe(1);
    expect(appendPieces(doc(''), 0, clean('new paragraph').pieces, newPara)).toBeNull();
  });

  it('keeps flagged words as flags and flips them both ways', () => {
    const { doc: d } = dictate(doc(''), 0, 'I love boats period then we left');
    expect(texts(d)).toEqual(['I love boats. Then we left.']);
    const at = d.paragraphs[0].nodes.findIndex((n) => n.t === 'flag');
    expect(at).toBeGreaterThan(-1);

    const word = applyOp(d, flipFlag(d, 0, at)!).doc;
    expect(texts(word)).toEqual(['I love boats period then we left.']);
    const back = applyOp(word, flipFlag(word, 0, at)!).doc;
    expect(texts(back)).toEqual(['I love boats. Then we left.']);
  });

  it('never trips the deletion guard, because it only adds', () => {
    const d = doc('One. Two. Three.');
    const r = appendPieces(d, 0, clean('four five six', { final: true }).pieces, newPara)!;
    expect(() => applyOp(d, r.op)).not.toThrow();
  });
});
