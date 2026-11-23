/**
 * Recording while the Mac is out of reach.
 *
 * The speech is kept on this device as audio. When the Mac can be reached
 * again it is transcribed there, in the order it was said, and goes into the
 * essay it was recorded for exactly as if it had just been spoken.
 */
import { db } from '../db/schema';
import { platform, Unreachable } from '../platform';
import { useStore } from '../store';
import { useSync } from './index';

async function count(accountId: string) {
  useSync.setState({ queued: await db.audioQueue.where('accountId').equals(accountId).count() });
}

/** Count the recordings waiting on this device (after a reload, for instance). */
export async function refreshQueued(): Promise<void> {
  const account = useStore.getState().account;
  if (account) await count(account.id);
}

/** Recordings are waiting, so anything said now must wait behind them to keep the order. */
export const hasQueuedAudio = () => useSync.getState().queued > 0;

/** Keep an utterance for later. Returns false if there is no essay open to put it in. */
export async function queueAudio(wav: ArrayBuffer, paused: boolean): Promise<boolean> {
  const { account, currentId } = useStore.getState();
  if (!account || !currentId) return false;
  await db.audioQueue.add({ accountId: account.id, essayId: currentId, ts: Date.now(), wav, paused });
  await count(account.id);
  return true;
}

let draining = false;

/** Transcribe what is waiting for the open essay. Stops quietly if the Mac goes out of reach again. */
export async function drainAudio(): Promise<void> {
  const account = useStore.getState().account;
  if (!account || draining) return;
  draining = true;
  try {
    await count(account.id);
    let done = 0;
    for (;;) {
      const essayId = useStore.getState().currentId;
      const all = await db.audioQueue.where('accountId').equals(account.id).sortBy('id');
      // Recordings for an essay that no longer exists can never be placed.
      const known = new Set(useStore.getState().essays.map((e) => e.id));
      for (const gone of all.filter((q) => !known.has(q.essayId))) await db.audioQueue.delete(gone.id!);
      const next = all.find((q) => q.essayId === essayId);
      if (!next) break;
      let heard;
      try {
        heard = await platform.transcribe(next.wav);
      } catch (err) {
        if (err instanceof Unreachable) useSync.setState({ online: false });
        break;
      }
      // The essay may have been switched while the Mac was working.
      if (useStore.getState().currentId !== next.essayId) continue;
      if (heard.words.length) await useStore.getState().insertHeard(heard.words, next.paused);
      await db.audioQueue.delete(next.id!);
      done++;
    }
    await count(account.id);
    if (done) useStore.getState().setToast({ text: done === 1 ? 'Back online. 1 recording was transcribed.' : `Back online. ${done} recordings were transcribed.` });
  } finally {
    draining = false;
  }
}
