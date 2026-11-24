import { describe, expect, it } from 'vitest';
import { isOwnVoice, rememberSpoken, speakable, speechUnits, splitSentences } from '../../src/speech';
import { EARCONS } from '../../src/voice/earcons';
import { Chunker, SAMPLE_RATE } from '../../src/dictation/chunker';
import { SPOKEN_RULES } from '../../src/llm/prompts';
import { looksDrafted } from '../../src/llm/guard';

describe('what Scribe says aloud', () => {
  it('turns on-screen text into something sayable', () => {
    expect(speakable('Look at P2·S3, and **cut** the e.g. part.')).toBe('Look at paragraph 2, sentence 3, and cut the for example part.');
    expect(speakable('See https://example.com/x for $E = mc^2$.')).toBe('See a link for a formula.');
  });

  it('splits a reply into sentences', () => {
    expect(splitSentences('That line works. What happened next? Tell me more')).toEqual(['That line works.', 'What happened next?', 'Tell me more']);
  });

  it('starts speaking at the first clause of the opening sentence, so it does not wait for the whole sentence', () => {
    expect(speechUnits('Your first two sentences are great because they start with action, but the third drags. Cut it.')).toEqual([
      'Your first two sentences are great because they start with action,', 'but the third drags.', 'Cut it.',
    ]);
    // Short openings are not chopped up.
    expect(speechUnits('Yes, it does. Keep going.')).toEqual(['Yes, it does.', 'Keep going.']);
  });

  it('keeps earlier pieces fixed as more of the reply arrives', () => {
    const full = 'Your opening hits hard because it starts with action, which feels like you. I like the rope. What came next?';
    let seen: string[] = [];
    for (let i = 10; i <= full.length; i += 7) {
      const units = speechUnits(full.slice(0, i));
      // Everything but the last (possibly unfinished) piece must already have been final.
      expect(units.slice(0, Math.min(seen.length, units.length) - 1)).toEqual(seen.slice(0, Math.min(seen.length, units.length) - 1));
      seen = units;
    }
    expect(speechUnits(full)).toHaveLength(4);
  });
});

describe('recognising its own voice', () => {
  it('spots a transcript of what it just said, even with a few words misheard', () => {
    rememberSpoken('That second line is doing a lot of work for you. What did your grandfather say next?');
    expect(isOwnVoice('That second line is doing a lot of work for you.')).toBe(true);
    expect(isOwnVoice('second line is doing lot of work for you what did your grandfather say')).toBe(true);
  });

  it('does not mistake the student for itself', () => {
    rememberSpoken('That second line is doing a lot of work for you.');
    expect(isOwnVoice('He said the mistake was in the notebook, not in my hands.')).toBe(false);
    expect(isOwnVoice('Wait, hold on a second.')).toBe(false);
    expect(isOwnVoice('Yes.')).toBe(false);
  });

  it('does not drop a short question because its words are scattered through a long answer', () => {
    rememberSpoken('The opening is strong, but is it clear why the summer mattered to you? I think the middle drags a little.');
    rememberSpoken('Your ending lands on the notebook, which is the right image. Say what changed in you after that.');
    expect(isOwnVoice('Is the ending clear?')).toBe(false);
    expect(isOwnVoice('What is missing from this essay?')).toBe(false);
    // The same words as one stretch of what was said are still an echo.
    expect(isOwnVoice('Your ending lands on the notebook.')).toBe(true);
  });
});

describe('the spoken persona', () => {
  it('asks for short spoken turns and still forbids drafting', () => {
    expect(SPOKEN_RULES).toContain('One to four short sentences');
    expect(SPOKEN_RULES).toContain('you never write, rewrite or draft their essay');
  });

  it('applies the drafting check to speech as it is voiced', () => {
    const essay = 'The engine did not start. He laughed.';
    const draft = 'Sure. I spent eleven days in the garage with my grandfather. My hands were black with grease by the end. We pulled the cord together and nothing happened.';
    // The check trips before the drafted run could be spoken to the end.
    const units = speechUnits(draft);
    const trippedAt = units.findIndex((_, i) => looksDrafted(units.slice(0, i + 1).join(' '), essay).drafted);
    expect(trippedAt).toBeGreaterThan(-1);
    expect(trippedAt).toBeLessThan(units.length);
  });
});

describe('earcons', () => {
  it('has the seven cues the brief lists, plus listening stopped', () => {
    expect(EARCONS.map((e) => e.id)).toEqual(['wake', 'listenStart', 'listenStop', 'applied', 'confirm', 'failed', 'saved', 'counselor']);
    for (const e of EARCONS) expect(e.label.length).toBeGreaterThan(5);
  });
});

describe('starting transcription early', () => {
  // A voice-like tone: it swells and dips several times a second, as syllables do.
  const tone = (seconds: number) =>
    Float32Array.from({ length: seconds * SAMPLE_RATE }, (_, i) => 0.2 * Math.sin(i / 5) * (0.08 + 0.92 * Math.abs(Math.sin((Math.PI * 4 * i) / SAMPLE_RATE))));
  const quiet = (seconds: number) => new Float32Array(seconds * SAMPLE_RATE);

  it('offers the audio at the start of a pause, and reports how long ago speech stopped when the chunk closes', () => {
    const events: string[] = [];
    const chunker = new Chunker({
      endSilence: 0.6,
      earlyQuiet: 0.12,
      onEarly: (s) => events.push(`early ${(s.length / SAMPLE_RATE).toFixed(1)}`),
      onChunk: (s, paused, quietSeconds) => events.push(`chunk ${(s.length / SAMPLE_RATE).toFixed(1)} ${paused} quiet ${quietSeconds.toFixed(1)}`),
    });
    for (const part of [quiet(0.5), tone(1), quiet(1)]) for (let i = 0; i < part.length; i += 800) chunker.feed(part.slice(i, i + 800));
    expect(events).toHaveLength(2);
    expect(events[0]).toMatch(/^early 1.[3-5]$/);
    expect(events[1]).toMatch(/^chunk (1\.[89]|2\.0) true quiet 0\.6$/);
  });

  it('offers again if the speaker carries on after a short pause', () => {
    let early = 0;
    let chunks = 0;
    const chunker = new Chunker({ endSilence: 0.6, earlyQuiet: 0.12, onEarly: () => early++, onChunk: () => chunks++ });
    for (const part of [tone(1), quiet(0.3), tone(1), quiet(1)]) for (let i = 0; i < part.length; i += 800) chunker.feed(part.slice(i, i + 800));
    expect(early).toBe(2);
    expect(chunks).toBe(1);
  });
});

describe('how much of the conversation the model is shown', () => {
  it('keeps the start of the window fixed for a block of turns, so the model does not re-read it every turn', async () => {
    const { recentHistory } = await import('../../src/llm/counselor');
    const upTo = (n: number) => Array.from({ length: n }, (_, i) => i);
    expect(recentHistory(upTo(24))).toHaveLength(24);
    expect(recentHistory(upTo(25))[0]).toBe(12);
    expect(recentHistory(upTo(36))[0]).toBe(12);
    expect(recentHistory(upTo(37))[0]).toBe(24);
    for (let n = 0; n < 200; n++) {
      const shown = recentHistory(upTo(n));
      expect(shown.length).toBeLessThanOrEqual(24);
      if (n >= 12) expect(shown.length).toBeGreaterThanOrEqual(12);
      expect(shown.at(-1)).toBe(n ? n - 1 : undefined);
    }
  });
});

describe('telling a voice from outdoor noise', () => {
  it('the rumble filter removes what is below a voice and keeps the voice', async () => {
    const { makeHighPass } = await import('../../src/dictation/frontend');
    const level = (x: Float32Array) => Math.sqrt(x.slice(4000).reduce((n, v) => n + v * v, 0) / (x.length - 4000));
    const sine = (hz: number) => Float32Array.from({ length: 16000 }, (_, i) => Math.sin((2 * Math.PI * hz * i) / 16000));
    expect(level(makeHighPass()(sine(30))) / level(sine(30))).toBeLessThan(0.1);
    expect(level(makeHighPass()(sine(400))) / level(sine(400))).toBeGreaterThan(0.95);
  });

  it('a sound with a pitch counts as voiced; hiss does not', async () => {
    const { voicedShare, looksLikeNoise } = await import('../../src/dictation/frontend');
    let seed = 3;
    const hiss = Float32Array.from({ length: 32000 }, () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296 - 0.5) * 0.4);
    const vowel = Float32Array.from({ length: 32000 }, (_, i) => 0.2 * Math.sin((2 * Math.PI * 140 * i) / 16000) + 0.1 * Math.sin((2 * Math.PI * 280 * i) / 16000));
    expect(voicedShare(hiss)).toBeLessThan(0.1);
    expect(voicedShare(vowel)).toBeGreaterThan(0.9);
    const words = (text: string, p: number) => text.split(' ').map((t) => ({ text: t, p }));
    // Whisper "heard" a sentence in hiss, and was not sure of it: dropped.
    expect(looksLikeNoise({ text: "And I'll see you next time.", words: words("And I'll see you next time.", 0.6), quality: { noSpeech: 0, logprob: -0.4 } }, hiss)).toBe(true);
    // The same words, said: kept.
    expect(looksLikeNoise({ text: "And I'll see you next time.", words: words("And I'll see you next time.", 0.6), quality: { noSpeech: 0, logprob: -0.4 } }, vowel)).toBe(false);
    // A whisper has no pitch, but Whisper is sure of the words: kept.
    expect(looksLikeNoise({ text: 'The boat was gone.', words: words('The boat was gone.', 0.95), quality: { noSpeech: 0, logprob: -0.1 } }, hiss)).toBe(false);
    // Stock phrases Whisper writes for silence, with low confidence: dropped. Said clearly: kept.
    expect(looksLikeNoise({ text: 'Thank you.', words: words('Thank you.', 0.5), quality: { noSpeech: 0.5, logprob: -0.6 } })).toBe(true);
    expect(looksLikeNoise({ text: 'Thank you.', words: words('Thank you.', 0.97), quality: { noSpeech: 0.01, logprob: -0.1 } })).toBe(false);
  });

  it('steady background does not hold a stretch of speech open, and quieter voices nearby do not start one', () => {
    const rate = SAMPLE_RATE;
    const voice = (seconds: number, level: number) =>
      Float32Array.from({ length: seconds * rate }, (_, i) => level * Math.sin(i / 5) * (0.08 + 0.92 * Math.abs(Math.sin((Math.PI * 4 * i) / rate))));
    let seed = 9;
    const noise = (seconds: number, level: number) => Float32Array.from({ length: seconds * rate }, () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296 - 0.5) * 2 * level);
    const add = (a: Float32Array, b: Float32Array) => a.map((v, i) => v + b[i]);
    const chunks: number[] = [];
    const chunker = new Chunker({ endSilence: 0.8, onChunk: (s) => chunks.push(s.length / rate) });
    const feed = (x: Float32Array) => { for (let i = 0; i < x.length; i += 800) chunker.feed(x.slice(i, i + 800)); };
    // Background alone, then two sentences over it, then background alone again.
    feed(noise(6, 0.03));
    feed(add(voice(2, 0.3), noise(2, 0.03)));
    feed(noise(2, 0.03));
    feed(add(voice(2, 0.3), noise(2, 0.03)));
    feed(noise(6, 0.03));
    // A much quieter voice nearby.
    feed(add(voice(2, 0.04), noise(2, 0.03)));
    feed(noise(3, 0.03));
    chunker.flush();
    const spoken = chunks.filter((c) => c > 1.5);
    expect(spoken).toHaveLength(2);
    for (const c of spoken) expect(c).toBeLessThan(4);
  });
});

describe('review fixes for outdoor dictation', () => {
  it('a name inside a request is kept; only a repeated call is trimmed', async () => {
    const { readWake } = await import('../../src/voice/wake');
    const w = (s: string) => s.split(' ').map((text) => ({ text }));
    const rest = (s: string) => readWake(w(s)).rest.map((x) => x.text).join(' ');
    expect(rest('Jarvis, replace Jarvis with Travis')).toBe('replace Jarvis with Travis');
    expect(rest('Jarvis, Ando, Jarvis, Ando,')).toBe('Ando,');
    expect(rest('Jarvis, go back to the sentence about Jarvis')).toBe('go back to the sentence about Jarvis');
  });

  it('a quieter speaker is heard again after at most two stretches are set aside', () => {
    const rate = SAMPLE_RATE;
    const voice = (seconds: number, level: number) =>
      Float32Array.from({ length: seconds * rate }, (_, i) => level * Math.sin(i / 5) * (0.08 + 0.92 * Math.abs(Math.sin((Math.PI * 4 * i) / rate))));
    const quiet = (seconds: number) => new Float32Array(seconds * rate);
    const got: number[] = [];
    const chunker = new Chunker({ endSilence: 0.8, onChunk: (s) => got.push(s.length) });
    const feed = (x: Float32Array) => { for (let i = 0; i < x.length; i += 800) chunker.feed(x.slice(i, i + 800)); };
    feed(voice(2, 0.5));
    feed(quiet(1.5));
    // The same person at a fifth of the level (a different microphone, say).
    for (let k = 0; k < 4; k++) {
      feed(voice(2, 0.1));
      feed(quiet(1.5));
    }
    const kept = got.slice(1).filter((n) => n > 0).length;
    expect(got[0]).toBeGreaterThan(0);
    expect(kept).toBeGreaterThanOrEqual(2);
  });

  it('a long stretch closed at a short breath is reported as cut, not as the end of a sentence', () => {
    const rate = SAMPLE_RATE;
    const voice = (seconds: number) =>
      Float32Array.from({ length: seconds * rate }, (_, i) => 0.3 * Math.sin(i / 5) * (0.08 + 0.92 * Math.abs(Math.sin((Math.PI * 4 * i) / rate))));
    const events: string[] = [];
    const chunker = new Chunker({ endSilence: 0.8, onChunk: (s, paused) => events.push(`${Math.round(s.length / rate)}s ${paused ? 'paused' : 'cut'}`) });
    const feed = (x: Float32Array) => { for (let i = 0; i < x.length; i += 800) chunker.feed(x.slice(i, i + 800)); };
    feed(voice(15));
    feed(new Float32Array(Math.round(0.35 * rate)));
    feed(voice(2));
    feed(new Float32Array(2 * rate));
    expect(events[0]).toMatch(/^1[56]s cut$/);
    expect(events[1]).toMatch(/paused$/);
  });

  it('"Yeah." said aloud is kept even when Whisper is unsure of it', async () => {
    const { looksLikeNoise } = await import('../../src/dictation/frontend');
    const vowel = Float32Array.from({ length: 16000 }, (_, i) => 0.2 * Math.sin((2 * Math.PI * 140 * i) / 16000));
    expect(looksLikeNoise({ text: 'Yeah.', words: [{ text: 'Yeah.', p: 0.6 }], quality: { noSpeech: 0.1, logprob: -0.5 } }, vowel)).toBe(false);
  });
});
