import { describe, expect, it } from 'vitest';
import { clean, guard, type HeardWord, type Piece } from '../../src/dictation/clean';

const final = (s: string | HeardWord[]) => clean(s, { final: true }).text;
const flags = (pieces: Piece[]) => pieces.filter((p) => p.t === 'flag');

/** Words with timings: a number between words is a pause in seconds. */
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

describe('acceptance cases from the brief', () => {
  it('"um so I uh went to the the dock" becomes "So I went to the dock."', () => {
    expect(final('um so I uh went to the the dock')).toBe('So I went to the dock.');
  });

  it('keeps "period" in "the Jurassic period was huge"', () => {
    const r = clean('the Jurassic period was huge', { final: true });
    expect(r.text).toBe('The Jurassic period was huge.');
    expect(flags(r.pieces)).toEqual([]);
  });

  it('turns "I love boats period" into "I love boats."', () => {
    const r = clean('I love boats period', { final: true });
    expect(r.text).toBe('I love boats.');
    expect(flags(r.pieces)).toEqual([]);
  });

  it('ignores the "..." Whisper sometimes writes for a hesitation', () => {
    expect(final('Um so I... uh... went to the the dock. I love boats period. The Jurassic period was huge.')).toBe(
      'So I went to the dock. I love boats. The Jurassic period was huge.',
    );
  });

  it('handles the same three sentences as Whisper really wrote them', () => {
    expect(final('Um, so I, uh, went to the the dock. I love boats, period. The Jurassic period was huge.')).toBe(
      'So I went to the dock. I love boats. The Jurassic period was huge.',
    );
  });
});

describe('fillers', () => {
  it('removes um, uh, er and tidies their commas', () => {
    expect(final('I went, um, to the dock')).toBe('I went to the dock.');
    expect(final('Uh, we left. Um. Then it rained.')).toBe('We left. Then it rained.');
  });

  it('removes hesitation sounds however long they are drawn out', () => {
    expect(final('Uhhhhh, we left early.')).toBe('We left early.');
    expect(final('I went, uhhhhhhh, to the dock')).toBe('I went to the dock.');
    expect(final('So ummmmm I waited')).toBe('So I waited.');
    expect(final('Hmmmm. The engine. Errrr. It did not start.')).toBe('The engine. It did not start.');
    expect(final('We tried again... uhhh... and again')).toBe('We tried again and again.');
    expect(final('Ahhhh I forgot the rope')).toBe('I forgot the rope.');
    expect(final('Uhhhh.')).toBe('');
    expect(final('Mmmm, uh, ehhh, okay we go')).toBe('Okay we go.');
  });

  it('keeps short words that are meant', () => {
    expect(final('Oh, I see. Ah, there it is.')).toBe('Oh, I see. Ah, there it is.');
    expect(final('To err is human')).toBe('To err is human.');
    expect(final('The hum of the engine')).toBe('The hum of the engine.');
  });

  it('keeps "like" when it means something', () => {
    expect(final('I like boats')).toBe('I like boats.');
    expect(final('It looks like rain and I would like to go')).toBe('It looks like rain and I would like to go.');
    expect(final('She ran like the wind')).toBe('She ran like the wind.');
  });

  it('removes "like" when it is a filler', () => {
    expect(final('It was, like, really cold')).toBe('It was really cold.');
    expect(final('Like, I went home')).toBe('I went home.');
    expect(final('so um like we went home')).toBe('So we went home.');
  });

  it('keeps "like" after a filler when it is still the verb', () => {
    expect(final('I um like boats')).toBe('I like boats.');
  });

  it('removes "you know" only when it is set off', () => {
    expect(final('It was, you know, a long day')).toBe('It was a long day.');
    expect(final('Do you know the way')).toBe('Do you know the way.');
  });
});

describe('repeats and false starts', () => {
  it('collapses repeated words and restarts', () => {
    expect(final('I was I was going to the the store')).toBe('I was going to the store.');
    expect(final('we went to, to the lake')).toBe('We went to the lake.');
  });

  it('removes stutters and cut-off words', () => {
    expect(final('the b-b-boat was w- was gone')).toBe('The boat was gone.');
  });

  it('keeps deliberate doubles', () => {
    expect(final('it was very very cold and I had had enough')).toBe('It was very very cold and I had had enough.');
  });
});

describe('spoken punctuation', () => {
  it('applies commands at the end of what was said', () => {
    expect(final('are you coming question mark')).toBe('Are you coming?');
    expect(final('we won exclamation point')).toBe('We won!');
    expect(final('first comma second semicolon third')).toBe('First, second; third.');
  });

  it('keeps the words when they are being talked about', () => {
    expect(final('I had a free period after lunch')).toBe('I had a free period after lunch.');
    expect(final('the comma is in the wrong place')).toBe('The comma is in the wrong place.');
    expect(final('it lasted for a long period of time')).toBe('It lasted for a long period of time.');
    expect(final('there is a question mark over the plan')).toBe('There is a question mark over the plan.');
  });

  it('flags a command it is not sure about, with the other reading ready', () => {
    const r = clean('I love boats period then we left', { final: true });
    expect(r.text).toBe('I love boats. Then we left.');
    expect(flags(r.pieces)).toEqual([{ t: 'flag', text: '.', alt: ' period', cap: true }]);
  });

  it('is sure when a pause follows the command', () => {
    const r = clean(timed('I love boats period', 0.6, 'then we left'), { final: true });
    expect(r.text).toBe('I love boats. Then we left.');
    expect(flags(r.pieces)).toEqual([]);
  });

  it('flags a word it is not sure about', () => {
    const r = clean('boats period was the title', { final: true });
    expect(r.text).toBe('Boats period was the title.');
    expect(flags(r.pieces)).toEqual([{ t: 'flag', text: ' period', alt: '.' }]);
  });

  it('asks when a determiner two words back makes it unclear', () => {
    const typed = clean('that was the end period', { final: true });
    expect(flags(typed.pieces)).toEqual([{ t: 'flag', text: ' period', alt: '.' }]);
    const spoken = clean(timed('that was the end', 0.6, 'period'), { final: true });
    expect(spoken.text).toBe('That was the end.');
    expect(flags(spoken.pieces)).toEqual([{ t: 'flag', text: '.', alt: ' period' }]);
  });

  it('handles new paragraph and new line', () => {
    const r = clean('that was the end new paragraph the next day we left', { final: true });
    expect(r.text).toBe('That was the end.\n\nThe next day we left.');
    expect(final('I wrote a new line of code')).toBe('I wrote a new line of code.');
  });

  it('handles quotes', () => {
    expect(final('he said quote come back tomorrow end quote and left')).toBe('He said “come back tomorrow” and left.');
    expect(final('my favorite quote is from my coach')).toBe('My favorite quote is from my coach.');
  });

  it('handles dash', () => {
    expect(final(timed('it was simple', 0.5, 'dash', 0.5, 'we lost'))).toBe('It was simple — we lost.');
    expect(final('I had to dash across the road')).toBe('I had to dash across the road.');
  });
});

describe('capitals and sentence ends', () => {
  it('capitalises sentence starts and the word I', () => {
    expect(final("then i said i'm done. and i left")).toBe("Then I said I'm done. And I left.");
  });

  it('does not add a period mid-thought, and continues in lower case', () => {
    expect(clean('So I went to the').text).toBe('So I went to the');
    expect(clean('Dock with my brother.', { continuing: true }).text).toBe('dock with my brother.');
  });

  it('drops Whisper notes that are not speech', () => {
    expect(final('[BLANK_AUDIO]')).toBe('');
    expect(final('We left. (upbeat music)')).toBe('We left.');
  });
});

describe('the no-added-words guard', () => {
  it('accepts removals and rejects any new or reordered word', () => {
    expect(guard('um so I went to the the dock', 'So I went to the dock.')).toBe(true);
    expect(guard('I went to the dock', 'I happily went to the dock.')).toBe(false);
    expect(guard('I went to the dock', 'To the dock I went.')).toBe(false);
  });

  it('holds for every cleaned example above', () => {
    const samples = [
      'um so I uh went to the the dock', 'I love boats period then we left', 'It was, like, really cold',
      'the b-b-boat was w- was gone', 'he said quote come back tomorrow end quote and left',
      'that was the end new paragraph the next day we left',
    ];
    for (const s of samples) expect(guard(s, final(s))).toBe(true);
  });
});
