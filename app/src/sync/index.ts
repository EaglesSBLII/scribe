/**
 * Keeps this device's copy and the Mac's master copy the same.
 *
 * Synced: essays, counselor conversations, brainstorm stories, the voice
 * memory and settings. Not synced: undo history and saved versions (they stay
 * on the device that made them), grades, and uploaded paper formats.
 */
import { create } from 'zustand';
import { db, type ChatRow, type EssayRow, type MemoryRow, type StoryRow } from '../db/schema';
import { platform, Unreachable, type SyncRecord } from '../platform';
import { useStore } from '../store';
import { useSettings } from '../settings';
import { useMemory } from '../memory/store';
import { useCounselor } from '../llm/counselor';
import { hashOf, idOf, plan, type Agreed, type LocalItem } from './engine';
import { drainAudio, refreshQueued } from './queue';

interface SyncState {
  /** The Mac answered the last time it was asked. */
  online: boolean;
  /** This page is on another device (a phone), not on the Mac. */
  remote: boolean;
  lastAt: number | null;
  /** Recordings waiting to be transcribed. */
  queued: number;
}

export const useSync = create<SyncState>(() => ({ online: true, remote: false, lastAt: null, queued: 0 }));

/** Settings that describe this device, not the writer. */
const DEVICE_ONLY = new Set(['lastEssayId']);
const EVERY_MS = 4000;

const chatKey = (c: Pick<ChatRow, 'essayId' | 'ts' | 'role'>) => `${c.essayId}:${c.ts}:${c.role}`;
const revKey = (accountId: string) => `syncRev:${accountId}`;

/** Everything of this account's on this device, in the form it is sent. */
async function snapshot(accountId: string): Promise<LocalItem[]> {
  const out: LocalItem[] = [];
  const essays = await db.essays.where('accountId').equals(accountId).toArray();
  for (const { accountId: _a, ...value } of essays) out.push({ coll: 'essays', key: value.id, value, updatedAt: value.updatedAt });
  const ids = new Set(essays.map((e) => e.id));
  for (const { id: _id, ...value } of await db.chats.toArray()) {
    if (ids.has(value.essayId)) out.push({ coll: 'chats', key: chatKey(value), value, updatedAt: value.ts });
  }
  for (const { accountId: _a, ...value } of await db.stories.where('accountId').equals(accountId).toArray()) {
    out.push({ coll: 'stories', key: value.id, value });
  }
  for (const { accountId: _a, ...value } of await db.memory.where('accountId').equals(accountId).toArray()) {
    out.push({ coll: 'memory', key: value.id, value });
  }
  const settings = await db.settings.where('[accountId+key]').between([accountId, ''], [accountId, '￿']).toArray();
  for (const s of settings) if (!DEVICE_ONLY.has(s.key)) out.push({ coll: 'settings', key: s.key, value: { value: s.value } });
  return out;
}

async function findChat(key: string): Promise<ChatRow | undefined> {
  const essayId = key.slice(0, key.indexOf(':'));
  return (await db.chats.where('essayId').equals(essayId).toArray()).find((c) => chatKey(c) === key);
}

/** Write one record from the Mac into this device's database. Essays go through the store instead. */
async function applyRecord(accountId: string, r: SyncRecord) {
  if (r.coll === 'chats') {
    const have = await findChat(r.key);
    if (r.deleted) {
      if (have?.id !== undefined) await db.chats.delete(have.id);
    } else if (!have) await db.chats.add(r.value as ChatRow);
  } else if (r.coll === 'stories') {
    if (r.deleted) await db.stories.delete(r.key);
    else await db.stories.put({ ...(r.value as Omit<StoryRow, 'accountId'>), accountId });
  } else if (r.coll === 'memory') {
    if (r.deleted) await db.memory.delete(r.key);
    else await db.memory.put({ ...(r.value as Omit<MemoryRow, 'accountId'>), accountId });
  } else if (r.coll === 'settings') {
    if (r.deleted) await db.settings.delete([accountId, r.key]);
    else await db.settings.put({ accountId, key: r.key, value: (r.value as { value: unknown }).value });
  }
}

let running = false;

/** One round. Returns false when the Mac could not be reached. */
export async function syncNow(): Promise<boolean> {
  const account = useStore.getState().account;
  if (!account || running) return true;
  running = true;
  try {
    const accountId = account.id;
    const stateId = (id: string) => `${accountId}|${id}`;
    const agreed = new Map<string, Agreed>();
    for (const s of await db.syncState.where('accountId').equals(accountId).toArray()) {
      agreed.set(s.id.slice(accountId.length + 1), { hash: s.hash, deleted: s.deleted });
    }
    const since = Number((await db.meta.get(revKey(accountId)))?.value ?? 0);
    const { push, hashes } = plan(await snapshot(accountId), agreed, Date.now());
    const answer = await platform.syncExchange({ email: account.email, since, push });

    const agree = async (id: string, hash: string, deleted = false) => {
      agreed.set(id, { hash, deleted });
      await db.syncState.put({ id: stateId(id), accountId, hash, deleted });
    };
    const sent = new Map(push.map((p) => [idOf(p.coll, p.key), p]));
    for (const id of answer.accepted) {
      const p = sent.get(id);
      if (p) await agree(id, p.deleted ? '' : (hashes.get(id) ?? ''), !!p.deleted);
    }

    const incoming: { row: EssayRow; agreed?: Agreed }[] = [];
    const removed: string[] = [];
    let touched = false;
    for (const r of answer.pull) {
      const id = idOf(r.coll, r.key);
      if (r.coll === 'essays') {
        if (r.deleted) removed.push(r.key);
        else incoming.push({ row: { ...(r.value as Omit<EssayRow, 'accountId'>), accountId }, agreed: agreed.get(id) });
        continue;
      }
      await applyRecord(accountId, r);
      await agree(id, r.deleted ? '' : hashOf(r.coll, r.value), !!r.deleted);
      touched = true;
    }
    if (incoming.length || removed.length) {
      const kept = new Set(await useStore.getState().absorbEssays(incoming, removed));
      for (const r of answer.pull) {
        if (r.coll !== 'essays' || kept.has(r.key)) continue;
        await agree(idOf(r.coll, r.key), r.deleted ? '' : hashOf(r.coll, r.value), !!r.deleted);
      }
    }
    await db.meta.put({ key: revKey(accountId), value: answer.rev });

    if (touched) {
      // Show what arrived.
      await useSettings.getState().load(accountId);
      await useMemory.getState().load(accountId);
      const counselor = useCounselor.getState();
      const essayId = useStore.getState().currentId;
      if (essayId && !counselor.busy) await counselor.load(essayId);
    }
    useSync.setState({ online: true, lastAt: Date.now() });
    return true;
  } catch (err) {
    if (!(err instanceof Unreachable)) console.debug('Scribe could not sync', err);
    useSync.setState({ online: false });
    return false;
  } finally {
    running = false;
  }
}

let timer: ReturnType<typeof setInterval> | undefined;

async function round() {
  if (document.visibilityState === 'hidden') return;
  await refreshQueued();
  if (await syncNow()) await drainAudio();
}

// A phone that opens Scribe with no connection cannot ask the Mac what it is, so it remembers.
const REMOTE_FLAG = 'scribe.remoteDevice';
function recallRemote(remote: boolean): boolean {
  try {
    if (remote) localStorage.setItem(REMOTE_FLAG, '1');
    return remote || localStorage.getItem(REMOTE_FLAG) === '1';
  } catch {
    return remote;
  }
}

/** Forget that this device signs in to a Mac (after signing out). */
export function forgetRemote() {
  try {
    localStorage.removeItem(REMOTE_FLAG);
  } catch { /* storage is not available */ }
}

/** Begin syncing in the background. Safe to call more than once. */
export function startSync(remote: boolean) {
  useSync.setState({ remote: recallRemote(remote) });
  if (timer) return;
  timer = setInterval(() => void round(), EVERY_MS);
  window.addEventListener('online', () => void round());
  document.addEventListener('visibilitychange', () => void round());
  void round();
}
