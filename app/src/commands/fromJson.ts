/**
 * Turns the model's structured reading of a spoken request into a command,
 * checking everything in code. The model can only choose which operation is
 * meant and point at a place; any words it passes along must be the
 * speaker's own, in the speaker's order, or the request is rejected.
 */
import { guard, type HeardWord } from '../dictation/clean';
import type { RequestJson } from '../llm/assist';
import type { Command, ParaRef, SentRef } from './parse';

const whole = (n: unknown): number => (typeof n === 'number' && Number.isInteger(n) ? n : 0);
const para = (n: number): ParaRef | undefined => (n === -1 ? 'last' : n >= 1 && n <= 200 ? n : undefined);
const sent = (n: number): SentRef | undefined => (n === -1 ? 'last' : n >= 1 && n <= 500 ? n : undefined);
const words = (text: string): HeardWord[] => text.trim().split(/\s+/).filter(Boolean).map((t) => ({ text: t }));

export function fromJson(json: RequestJson, said: string): Command | null {
  const t = json.target ?? ({} as RequestJson['target']);
  const a = json.args ?? ({} as RequestJson['args']);
  const p = para(whole(t.paragraph));
  const s = sent(whole(t.sentence));
  const text = typeof a.text === 'string' ? a.text.trim() : '';

  switch (json.op) {
    case 'undo':
      return { k: 'undo' };
    case 'redo':
      return { k: 'redo' };

    case 'count':
      if (a.what === 'left') return { k: 'count', scope: 'left' };
      if (a.what === 'paragraph' || (t.unit === 'paragraph' && p !== undefined)) return { k: 'count', scope: 'paragraph', para: p ?? 'current' };
      return { k: 'count', scope: 'essay' };

    case 'read':
      if (t.unit === 'essay') return { k: 'read', what: 'essay' };
      if (t.unit === 'sentence' && s !== undefined) return { k: 'read', what: 'sentence', sent: s, para: p };
      if (t.unit === 'paragraph') return { k: 'read', what: 'paragraph', para: p ?? 'current' };
      return null;

    case 'delete': {
      if (t.unit === 'utterance') return { k: 'deleteUtterance' };
      if (t.unit === 'words') {
        const count = whole(t.count);
        return count >= 1 && count <= 200 ? { k: 'deleteWords', count } : null;
      }
      if (t.unit === 'sentence' && s !== undefined) {
        const to = whole(t.to_sentence);
        return { k: 'delete', what: 'sentences', from: s, to: to >= 1 && typeof s === 'number' && to > s ? to : undefined, para: p };
      }
      if (t.unit === 'paragraph') return { k: 'delete', what: 'paragraph', para: p ?? 'current' };
      return null;
    }

    case 'move': {
      const from = p ?? 'current';
      if (a.place === 'above' || a.place === 'below') {
        const other = para(whole(a.other_paragraph));
        return other === undefined ? null : { k: 'move', para: from, where: a.place, target: other };
      }
      if (a.place === 'up' || a.place === 'down' || a.place === 'top' || a.place === 'bottom') return { k: 'move', para: from, where: a.place };
      return null;
    }

    case 'replace': {
      const find = typeof a.find === 'string' ? a.find.trim() : '';
      const replacement = typeof a.with === 'string' ? a.with.trim() : '';
      // Both must be words the speaker actually said.
      if (!find || !replacement || !guard(said, find) || !guard(said, replacement)) return null;
      return { k: 'replace', find, with: replacement, para: t.unit === 'paragraph' ? p : undefined };
    }

    case 'insert': {
      // The inserted text must be the speaker's own words, in their order.
      if (!text || !guard(said, text)) return null;
      const at =
        a.place === 'start' ? ({ k: 'start' } as const)
        : a.place === 'end' ? ({ k: 'end' } as const)
        : a.place === 'before' && s !== undefined ? ({ k: 'before', sent: s } as const)
        : a.place === 'after' && s !== undefined ? ({ k: 'after', sent: s } as const)
        : null;
      return at ? { k: 'insert', words: words(text), at, para: p } : null;
    }

    case 'goto':
      return text && guard(said, text) ? { k: 'goto', about: text } : null;

    case 'mode': {
      const m = /coach/i.test(text) ? 'coach' : /conversation|talk/i.test(text) ? 'conversation' : /draft|quiet/i.test(text) ? 'draft' : null;
      return m ? { k: 'mode', mode: m } : null;
    }

    default:
      return null;
  }
}
