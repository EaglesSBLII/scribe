import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { hashOf, idOf, judgeEssay, plan, type Agreed } from '../../src/sync/engine';
import { makeResampler } from '../../src/dictation/resample';

const require = createRequire(import.meta.url);
const { createRemote } = require('../../../local/remote.js');
const { looksWrong } = require('../../../local/whisper.js');

const dirs: string[] = [];
function remote() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scribe-sync-'));
  dirs.push(dir);
  return { dir, r: createRemote(dir) };
}
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

const essay = (text: string, updatedAt: number) => ({ id: 'e1', title: 'T', updatedAt, doc: { paragraphs: [{ id: 'p', nodes: [{ t: 'text', text }] }] } });

describe('what a device sends', () => {
  it('sends everything the first time, and nothing when nothing changed', () => {
    const local = [{ coll: 'essays', key: 'e1', value: essay('one', 5), updatedAt: 5 }];
    const first = plan(local, new Map(), 100);
    expect(first.push).toHaveLength(1);
    expect(first.push[0]).toMatchObject({ coll: 'essays', key: 'e1', updatedAt: 5 });
    const agreed = new Map<string, Agreed>([[idOf('essays', 'e1'), { hash: first.hashes.get('essays|e1')! }]]);
    expect(plan(local, agreed, 200).push).toEqual([]);
  });

  it('sends a changed record, and a deletion for one that is gone', () => {
    const agreed = new Map<string, Agreed>([
      ['essays|e1', { hash: hashOf('essays', essay('one', 5)) }],
      ['memory|m1', { hash: 'x' }],
    ]);
    const { push } = plan([{ coll: 'essays', key: 'e1', value: essay('two', 9), updatedAt: 9 }], agreed, 300);
    expect(push).toEqual([
      { coll: 'essays', key: 'e1', value: essay('two', 9), updatedAt: 9 },
      { coll: 'memory', key: 'm1', value: null, updatedAt: 300, deleted: true },
    ]);
  });

  it('does not send a deletion twice', () => {
    const agreed = new Map<string, Agreed>([['memory|m1', { hash: '', deleted: true }]]);
    expect(plan([], agreed, 1).push).toEqual([]);
  });

  it('an essay whose text is the same is the same, whatever its clock says or the order of its fields', () => {
    expect(hashOf('essays', essay('one', 5))).toBe(hashOf('essays', essay('one', 99)));
    expect(hashOf('essays', { doc: essay('one', 1).doc, title: 'T', id: 'e1' })).toBe(hashOf('essays', essay('one', 1)));
    expect(hashOf('essays', essay('one', 5))).not.toBe(hashOf('essays', essay('one.', 5)));
  });
});

describe('two devices changed the same essay', () => {
  const h = (text: string) => hashOf('essays', essay(text, 0));
  it('takes the other copy when this device has nothing unsent', () => {
    expect(judgeEssay({ hash: h('a'), updatedAt: 5 }, { hash: h('a') }, { hash: h('b'), updatedAt: 3 })).toBe('take');
    expect(judgeEssay(null, undefined, { hash: h('b'), updatedAt: 3 })).toBe('take');
  });
  it('the newer copy wins, and the losing text is kept as a version', () => {
    expect(judgeEssay({ hash: h('mine'), updatedAt: 5 }, { hash: h('a') }, { hash: h('theirs'), updatedAt: 9 })).toBe('take-keep-version');
    expect(judgeEssay({ hash: h('mine'), updatedAt: 9 }, { hash: h('a') }, { hash: h('theirs'), updatedAt: 5 })).toBe('keep-mine');
  });
});

describe('the master copy on the Mac', () => {
  it('keeps the newer copy and hands the loser the winner', () => {
    const { r } = remote();
    expect(r.exchange('a@b.co', { since: 0, push: [{ coll: 'essays', key: 'e1', value: { t: 'new' }, updatedAt: 9 }] })).toMatchObject({ rev: 1, pull: [], accepted: ['essays|e1'] });
    const lost = r.exchange('a@b.co', { since: 1, push: [{ coll: 'essays', key: 'e1', value: { t: 'old' }, updatedAt: 4 }] });
    expect(lost.accepted).toEqual([]);
    expect(lost.pull).toMatchObject([{ key: 'e1', value: { t: 'new' }, updatedAt: 9 }]);
  });

  it('a second device receives what the first sent, once, and deletions too', () => {
    const { r } = remote();
    r.exchange('a@b.co', { since: 0, push: [{ coll: 'essays', key: 'e1', value: { t: 1 }, updatedAt: 1 }, { coll: 'memory', key: 'm1', value: { w: 'x' }, updatedAt: 1 }] });
    const phone = r.exchange('a@b.co', { since: 0, push: [] });
    expect(phone.pull.map((p: { key: string }) => p.key)).toEqual(['e1', 'm1']);
    expect(r.exchange('a@b.co', { since: phone.rev, push: [] }).pull).toEqual([]);
    r.exchange('a@b.co', { since: phone.rev, push: [{ coll: 'memory', key: 'm1', value: null, updatedAt: 5, deleted: true }] });
    expect(r.exchange('a@b.co', { since: phone.rev, push: [] }).pull).toMatchObject([{ key: 'm1', deleted: true, value: null }]);
  });

  it('keeps accounts apart, and survives a restart', () => {
    const { r, dir } = remote();
    r.exchange('a@b.co', { since: 0, push: [{ coll: 'essays', key: 'e1', value: { t: 1 }, updatedAt: 1 }] });
    expect(r.exchange('other@b.co', { since: 0, push: [] }).pull).toEqual([]);
    expect(createRemote(dir).exchange('A@B.co', { since: 0, push: [] }).pull).toHaveLength(1);
  });
});

describe('signing in from another device', () => {
  const from = (headers: Record<string, string>) => ({ headers });
  it('only a request made on the Mac itself counts as local', () => {
    const { r } = remote();
    expect(r.isLocal(from({ host: '127.0.0.1:4310' }))).toBe(true);
    expect(r.isLocal(from({ host: 'localhost:4310' }))).toBe(true);
    expect(r.isLocal(from({ host: 'macbook.tail1234.ts.net' }))).toBe(false);
    expect(r.isLocal(from({ host: '127.0.0.1:4310', 'x-forwarded-for': '100.64.0.2' }))).toBe(false);
    expect(r.isLocal(from({ host: 'evil.example' }))).toBe(false);
  });

  it('is off until a password is set on the Mac; then the right password signs in', () => {
    const { r, dir } = remote();
    expect(r.enabled()).toBe(false);
    expect(() => r.setPassword('a@b.co', 'short')).toThrow(/at least 8/);
    r.setPassword('A@b.co', 'correct horse');
    expect(r.enabled()).toBe(true);
    expect(() => r.login('a@b.co', 'wrong')).toThrow('Wrong email or password.');
    expect(() => r.login('nobody@b.co', 'correct horse')).toThrow('Wrong email or password.');
    const { token } = r.login('a@b.co', 'correct horse');
    expect(r.sessionOf(from({ cookie: `other=1; scribe_session=${token}` }))).toEqual({ email: 'a@b.co' });
    expect(r.sessionOf(from({ cookie: `scribe_session=${'0'.repeat(64)}` }))).toBeNull();
    // The password itself is never written down, only a salted hash.
    expect(fs.readFileSync(path.join(dir, 'auth.json'), 'utf8')).not.toContain('correct horse');
    expect(fs.readFileSync(path.join(dir, 'auth.json'), 'utf8')).not.toContain(token);
  });

  it('locks after five wrong passwords, and a new password or switching off signs devices out', () => {
    const { r } = remote();
    r.setPassword('a@b.co', 'correct horse');
    for (let i = 0; i < 5; i++) expect(() => r.login('a@b.co', 'nope', 1000)).toThrow('Wrong email or password.');
    expect(() => r.login('a@b.co', 'correct horse', 2000)).toThrow(/15 minutes/);
    const { token } = r.login('a@b.co', 'correct horse', 1000 + 16 * 60_000);
    r.setPassword('a@b.co', 'another one');
    expect(r.sessionOf(from({ cookie: `scribe_session=${token}` }), 1000 + 17 * 60_000)).toBeNull();
    const again = r.login('a@b.co', 'another one');
    r.disable('a@b.co');
    expect(r.sessionOf(from({ cookie: `scribe_session=${again.token}` }))).toBeNull();
    expect(r.enabled()).toBe(false);
  });

  it('old mistakes are forgotten: only a run of wrong passwords locks sign-in', () => {
    const { r } = remote();
    r.setPassword('a@b.co', 'correct horse');
    const hour = 3_600_000;
    for (let i = 0; i < 8; i++) expect(() => r.login('a@b.co', 'nope', 1000 + i * hour)).toThrow('Wrong email or password.');
    expect(r.login('a@b.co', 'correct horse', 1000 + 9 * hour).email).toBe('a@b.co');
  });

  it('a session ends after thirty days', () => {
    const { r } = remote();
    r.setPassword('a@b.co', 'correct horse');
    const { token } = r.login('a@b.co', 'correct horse', 0);
    expect(r.sessionOf(from({ cookie: `scribe_session=${token}` }), 29 * 86400_000)).not.toBeNull();
    expect(r.sessionOf(from({ cookie: `scribe_session=${token}` }), 31 * 86400_000)).toBeNull();
  });
});

describe('the quick transcriber is checked before it is trusted', () => {
  it('a repeated sentence, or more words than fit in the clip, is heard again in full', () => {
    expect(looksWrong('The boat was gone.\n The boat was gone.\n The boat was gone.', 3.6)).toBe(true);
    expect(looksWrong('one two three four five six seven eight nine ten eleven twelve', 1)).toBe(true);
    expect(looksWrong('The boat was gone. I waited.', 3.6)).toBe(false);
    expect(looksWrong('Jarvis. Jarvis.', 2)).toBe(false);
  });
});

describe('microphones that cannot record at 16 kHz', () => {
  it('passes 16 kHz audio through untouched', () => {
    const x = new Float32Array([0.1, 0.2]);
    expect(makeResampler(16000)(x)).toBe(x);
  });
  it('turns 48 kHz into 16 kHz, a third as many samples, across uneven blocks', () => {
    const to16 = makeResampler(48000);
    const tone = Float32Array.from({ length: 4800 }, (_, i) => Math.sin((2 * Math.PI * 440 * i) / 48000));
    const out = [...to16(tone.subarray(0, 1000)), ...to16(tone.subarray(1000, 1001)), ...to16(tone.subarray(1001))];
    expect(out).toHaveLength(1600);
    // Still a 440 Hz tone: compare with the same tone made at 16 kHz.
    const want = Float32Array.from({ length: 1600 }, (_, i) => Math.sin((2 * Math.PI * 440 * (i + 1 / 3)) / 16000));
    const worst = Math.max(...out.map((v, i) => Math.abs(v - want[i])));
    expect(worst).toBeLessThan(0.02);
  });
  it('handles 44.1 kHz, which is not a whole multiple', () => {
    const to16 = makeResampler(44100);
    let n = 0;
    for (let i = 0; i < 100; i++) n += to16(new Float32Array(128)).length;
    expect(Math.abs(n - (12800 * 16000) / 44100)).toBeLessThan(2);
  });
});
