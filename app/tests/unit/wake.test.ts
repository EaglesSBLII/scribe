import { describe, expect, it } from 'vitest';
import { isSleepRequest, readWake } from '../../src/voice/wake';
import type { HeardWord } from '../../src/dictation/clean';

const heard = (s: string): HeardWord[] => s.split(' ').map((text) => ({ text }));
/** Words with timings; a number is a pause in seconds before the next word. */
function timed(...parts: (string | number)[]): HeardWord[] {
  const out: HeardWord[] = [];
  let t = 0;
  for (const p of parts) {
    if (typeof p === 'number') t += p;
    else for (const w of p.split(' ')) {
      out.push({ text: w, start: t, end: t + 0.2 });
      t += 0.25;
    }
  }
  return out;
}
const rest = (s: string) => readWake(heard(s)).rest.map((w) => w.text).join(' ');

describe('the wake word', () => {
  it('"Jarvis" alone wakes it and waits for the request', () => {
    expect(readWake(heard('Jarvis.'))).toEqual({ wake: true, alone: true, rest: [] });
    expect(readWake(heard('jarvis'))).toMatchObject({ wake: true, alone: true });
  });

  it('"Hey Jarvis" works too, but is not needed', () => {
    expect(readWake(heard('Hey Jarvis.'))).toMatchObject({ wake: true, alone: true });
    expect(readWake(heard('Hey, Jarvis, word count.'))).toMatchObject({ wake: true, alone: false });
    expect(readWake(heard('Okay Jarvis, undo that.'))).toMatchObject({ wake: true });
  });

  it('"Jarvis, ..." makes what follows a request, and hands it over without the name', () => {
    expect(readWake(heard('Jarvis, delete the last sentence.'))).toMatchObject({ wake: true, alone: false });
    expect(rest('Jarvis, delete the last sentence.')).toBe('delete the last sentence.');
    expect(rest('Jarvis. How many words do I have?')).toBe('How many words do I have?');
    expect(rest('Jarvis what do you think about this')).toBe('what do you think about this');
  });

  it('accepts a pause after the name instead of a comma', () => {
    expect(readWake(timed('Jarvis', 0.5, 'the opening is too slow')).wake).toBe(true);
  });

  it('accepts the ways Whisper mishears the name said on its own or as a call', () => {
    for (const s of ['Jervis.', 'Jörvis.', 'Javez.', 'Hey Jermis.', 'Hey Jarmis!', 'Service.', 'Travis.', 'Javez, How many words do I have?', 'Travis, undo that.']) {
      expect(readWake(heard(s)).wake, s).toBe(true);
    }
  });
});

describe('the name as part of what is being dictated', () => {
  it.each([
    'My friend called me Jarvis.',
    'Everyone at camp called me Jarvis because of the movie.',
    'We named the robot Jarvis and it never worked.',
    'The first person I told was Jarvis.',
    'Jarvis was my nickname in middle school.',
    'Jarvis is what my little brother calls our dog.',
    'Jarvis and I rebuilt the engine that summer.',
  ])('stays text: %s', (s) => {
    expect(readWake(heard(s)).wake).toBe(false);
  });

  it('does not treat real words that sound like the name as a call inside a sentence', () => {
    for (const s of [
      'Travis drove us to the service station after practice.',
      'Service was slow that night.',
      'Our service project was at the clinic.',
      'Travis, my cousin, drove us home.',
      'It was a jarring sound.',
      'So I went to the dock.',
    ]) expect(readWake(heard(s)).wake, s).toBe(false);
  });
});

describe('ending the session by voice', () => {
  it('recognises requests to stop listening', () => {
    for (const s of ['stop listening', 'Go to sleep.', "That's all.", 'never mind', 'Goodbye.']) expect(isSleepRequest(heard(s)), s).toBe(true);
    for (const s of ['stop the engine', 'delete the last sentence', 'sleep was hard to come by']) expect(isSleepRequest(heard(s)), s).toBe(false);
  });
});
