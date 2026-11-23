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
  const tone = (seconds: number) => Float32Array.from({ length: seconds * SAMPLE_RATE }, (_, i) => 0.2 * Math.sin(i / 5));
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
    expect(events[0]).toMatch(/^early 1\.[34]$/);
    expect(events[1]).toMatch(/^chunk 1\.[89] true quiet 0\.6$/);
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
