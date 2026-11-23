/**
 * Paragraphs being typed in hold their text for up to half a second before
 * saving. Anything that needs the document up to date calls flushPending() first.
 */
const pending = new Map<string, () => void>();

export function registerPending(paraId: string, flush: () => void) {
  pending.set(paraId, flush);
}

export function clearPending(paraId: string) {
  pending.delete(paraId);
}

export function flushPending() {
  for (const flush of [...pending.values()]) flush();
  pending.clear();
}
