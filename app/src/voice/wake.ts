/**
 * The wake word "Jarvis", read from what Whisper heard.
 *
 * An utterance that begins with "Jarvis" is addressed to Scribe: a command or
 * a question, never essay text. "Jarvis" anywhere else in a sentence is just a
 * word the writer said. "Hey Jarvis" works too but is not needed.
 */
import type { HeardWord } from '../dictation/clean';

export interface Wake {
  /** The utterance was addressed to Scribe. */
  wake: boolean;
  /** Nothing followed the name: Scribe should answer and wait for the request. */
  alone: boolean;
  /** What was said after the name. */
  rest: HeardWord[];
}

const NO: Wake = { wake: false, alone: false, rest: [] };

// How Whisper writes the name. The second group are real words too, so they
// count only when set off as a call (alone, or followed by a comma or pause).
const NAMES = new Set(['jarvis', 'jervis', 'jarves', 'jarvus', 'jarvas', 'jarviss']);
// Real words Whisper sometimes writes for the name said on its own.
const SOUND_ALIKES = new Set(['travis', 'service', 'jarvie', 'jarvish']);
// Non-words in the shape of the name: "Javez", "Jorvis", "Jermis", "Charvis".
const NAME_SHAPE = /^(j|ch|dj)[aeou]r?[vmbf][aeiu][sz]s?$/;

/** Lower-case, without accents ("Jörvis" -> "jorvis"). */
const plain = (word: string) => word.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/’/g, "'");
const GREETINGS = new Set(['hey', 'hi', 'hello', 'ok', 'okay', 'yo']);

// "Jarvis was my nickname": the name is the subject of a sentence being dictated.
const CONTENT_NEXT = new Set([
  'was', 'is', 'were', 'had', 'has', 'would', 'said', 'says', 'and', 'or', 'who', 'came', 'went', 'will', "isn't", "wasn't", 'never', 'always',
  'became', 'looked', 'felt', 'thought', 'knew', 'made', 'took', 'got', 'the', 'from', 'in', 'of',
]);

// How a request to Scribe starts.
const REQUEST_STARTS = new Set([
  'delete', 'remove', 'erase', 'scratch', 'cut', 'undo', 'redo', 'insert', 'add', 'put', 'move', 'replace', 'change', 'read', 'how', 'what',
  "what's", 'word', 'go', 'stop', 'start', 'pause', 'resume', 'coach', 'draft', 'conversation', 'new', 'can', 'could', 'please', 'does', 'do',
  'should', 'why', 'where', 'which', 'when', 'tell', 'give', 'help', 'grade', 'switch', 'cancel', 'yes', 'no', 'never', 'quiet', 'sleep',
  'listen', 'repeat', 'say', 'find', 'show', 'open', 'close', 'equation', 'heading', 'caption', 'math',
]);

interface Tok {
  key: string;
  trail: string;
  word: HeardWord;
}

function tokens(heard: HeardWord[]): Tok[] {
  const out: Tok[] = [];
  for (const h of heard) {
    for (const raw of h.text.trim().split(/\s+/).filter(Boolean)) {
      const m = raw.match(/^[^\p{L}\p{N}]*(.*?)([^\p{L}\p{N}]*)$/u)!;
      if (!m[1]) {
        if (out.length) out[out.length - 1].trail += raw;
        continue;
      }
      out.push({ key: plain(m[1]), trail: m[2], word: { ...h, text: raw } });
    }
  }
  return out;
}

const PAUSE = 0.3;

export function readWake(heard: HeardWord[]): Wake {
  const toks = tokens(heard);
  let i = 0;
  if (toks.length > 1 && GREETINGS.has(toks[0].key)) i = 1;
  const name = toks[i];
  if (!name) return NO;
  const sure = NAMES.has(name.key);
  if (!sure && !SOUND_ALIKES.has(name.key) && !NAME_SHAPE.test(name.key)) return NO;

  const after = toks.slice(i + 1);
  // Whisper may leave its own punctuation on the first word of the request.
  const rest = after.map((t) => t.word);
  if (after.length === 0) return { wake: true, alone: true, rest: [] };

  // The name said twice ("Jarvis! Hey Jarvis!") is still just a call.
  const again = readWake(rest);
  if (again.wake) return again;

  const setOff = /[,.!?:;—–-]/.test(name.trail);
  const next = after[0];
  const gap = name.word.end !== undefined && next.word.start !== undefined ? next.word.start - name.word.end : 0;
  const request = REQUEST_STARTS.has(next.key);

  if (sure) {
    if (setOff || gap >= PAUSE) return { wake: true, alone: false, rest };
    // No comma and no pause: is the name the subject of a sentence, or a call?
    if (CONTENT_NEXT.has(next.key)) return NO;
    return request ? { wake: true, alone: false, rest } : NO;
  }
  // A sound-alike ("Travis") must be clearly a call and be followed by a request.
  return (setOff || gap >= PAUSE) && request ? { wake: true, alone: false, rest } : NO;
}

/** Requests that end the session and return to waiting for the wake word. */
export function isSleepRequest(rest: HeardWord[]): boolean {
  const text = rest.map((w) => w.text).join(' ').toLowerCase().replace(/[^a-z\s]/g, '').replace(/\s+/g, ' ').trim();
  return /^(stop listening|go to sleep|sleep|stop dictation|stop dictating|thats all|that is all|thank you thats all|goodbye|good night|never mind|nevermind|quiet)$/.test(text);
}
