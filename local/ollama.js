// Talks to the Ollama server on this machine. The address is fixed to 127.0.0.1:
// there is no setting that could point Scribe at a remote model.
const OLLAMA = 'http://127.0.0.1:11434';

async function models() {
  const res = await fetch(`${OLLAMA}/api/tags`);
  if (!res.ok) throw new Error('Ollama is not answering.');
  const data = await res.json();
  return (data.models ?? []).map((m) => m.name);
}

async function available() {
  try {
    return (await models()).length > 0;
  } catch {
    return false;
  }
}

/**
 * Run one chat request. `request` is { model, messages, format?, options? }.
 * `onDelta` receives text as it is produced. Resolves with the full reply.
 */
async function chat(request, onDelta, signal) {
  let res;
  try {
    res = await fetch(`${OLLAMA}/api/chat`, {
      method: 'POST',
      signal,
      body: JSON.stringify({
        model: request.model,
        messages: request.messages,
        format: request.format,
        stream: true,
        // Reasoning models answer directly; their hidden thinking is not needed here.
        think: false,
        keep_alive: '15m',
        options: { num_ctx: 8192, ...request.options },
      }),
    });
  } catch (err) {
    if (err.name === 'AbortError') throw err;
    throw new Error('Ollama is not running. Start it, or run ./setup.sh.');
  }
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(/not found/i.test(detail) ? `The model "${request.model}" is not downloaded. Run: ollama pull ${request.model}` : `Ollama failed (${res.status}).`);
  }
  let full = '';
  let buffered = '';
  const decoder = new TextDecoder();
  for await (const bytes of res.body) {
    buffered += decoder.decode(bytes, { stream: true });
    let nl;
    while ((nl = buffered.indexOf('\n')) >= 0) {
      const line = buffered.slice(0, nl).trim();
      buffered = buffered.slice(nl + 1);
      if (!line) continue;
      const part = JSON.parse(line);
      if (part.error) throw new Error(part.error);
      const delta = part.message?.content ?? '';
      if (delta) {
        full += delta;
        onDelta?.(delta);
      }
    }
  }
  return full;
}

/**
 * Unload a model so its next request starts cold. Ollama reuses work from
 * earlier requests, and how much it reuses changes the answer slightly, so
 * grading starts from this known state every time.
 */
async function unload(model) {
  await fetch(`${OLLAMA}/api/generate`, { method: 'POST', body: JSON.stringify({ model, keep_alive: 0 }) }).catch(() => {});
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${OLLAMA}/api/ps`);
      const running = ((await res.json()).models ?? []).map((m) => m.name);
      if (!running.includes(model)) return true;
    } catch {
      return false;
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

module.exports = { models, available, chat, unload };
