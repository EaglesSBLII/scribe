/**
 * The rules of syncing, with no database or network in them.
 *
 * Every device keeps its own full copy. The Mac holds the master copy. A
 * device sends what it changed since it last agreed with the Mac, and receives
 * what it is missing. When two devices changed the same record, the newer one
 * wins; for an essay, the losing text is kept as a version first.
 */
import type { SyncRecord } from '../platform';

/** One record on this device, in the form it is sent. */
export interface LocalItem {
  coll: string;
  key: string;
  value: unknown;
  /** When it was last changed, if the record says. */
  updatedAt?: number;
}

export interface Agreed {
  hash: string;
  deleted?: boolean;
}

export const idOf = (coll: string, key: string) => `${coll}|${key}`;

/** JSON with keys in a fixed order, so the same content always reads the same. */
function stable(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  const o = value as Record<string, unknown>;
  return `{${Object.keys(o).filter((k) => o[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${stable(o[k])}`).join(',')}}`;
}

/** A fingerprint of a record's content. An essay's "last changed" time is not content. */
export function hashOf(coll: string, value: unknown): string {
  let v = value;
  if (coll === 'essays' && v && typeof v === 'object') {
    const { updatedAt: _ignored, ...rest } = v as Record<string, unknown>;
    v = rest;
  }
  const text = stable(v);
  // cyrb53: a quick 53-bit hash. This only needs to notice change, not resist attack.
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 2654435761);
    h2 = Math.imul(h2 ^ c, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

/**
 * What this device has to send: everything that differs from what it last
 * agreed with the Mac, and a deletion for anything agreed that is now gone.
 */
export function plan(local: LocalItem[], agreed: Map<string, Agreed>, now: number): { push: SyncRecord[]; hashes: Map<string, string> } {
  const push: SyncRecord[] = [];
  const hashes = new Map<string, string>();
  const seen = new Set<string>();
  for (const item of local) {
    const id = idOf(item.coll, item.key);
    seen.add(id);
    const hash = hashOf(item.coll, item.value);
    hashes.set(id, hash);
    const was = agreed.get(id);
    if (was && !was.deleted && was.hash === hash) continue;
    push.push({ coll: item.coll, key: item.key, value: item.value, updatedAt: item.updatedAt ?? now });
  }
  for (const [id, was] of agreed) {
    if (seen.has(id) || was.deleted) continue;
    const bar = id.indexOf('|');
    push.push({ coll: id.slice(0, bar), key: id.slice(bar + 1), value: null, updatedAt: now, deleted: true });
  }
  return { push, hashes };
}

export type EssayVerdict = 'take' | 'take-keep-version' | 'keep-mine';

/**
 * What to do with the Mac's copy of an essay.
 *   mine      this device's copy now (null if it has none)
 *   agreed    the fingerprint last agreed with the Mac
 */
export function judgeEssay(
  mine: { hash: string; updatedAt: number } | null,
  agreed: Agreed | undefined,
  theirs: { hash: string; updatedAt: number },
): EssayVerdict {
  if (!mine || mine.hash === theirs.hash) return 'take';
  const unsent = !agreed || agreed.deleted || agreed.hash !== mine.hash;
  if (!unsent) return 'take';
  // Both sides changed it. The newer one wins; mine, if newer, goes up on the next round.
  return mine.updatedAt > theirs.updatedAt ? 'keep-mine' : 'take-keep-version';
}
