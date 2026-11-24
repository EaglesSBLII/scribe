// The only doorway between the page and the Mac app.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('scribeBridge', {
  asrAvailable: () => ipcRenderer.invoke('asr:available'),
  ttsInfo: () => ipcRenderer.invoke('tts:info'),
  ttsSpeak: (text, voice, speed) => ipcRenderer.invoke('tts:speak', text, voice, speed),
  asrTranscribe: (wav, quick) => ipcRenderer.invoke('asr:transcribe', wav, quick === true),
  syncExchange: (body) => ipcRenderer.invoke('sync:exchange', body),
  remoteStatus: (email) => ipcRenderer.invoke('remote:status', email),
  remoteSet: (email, password) => ipcRenderer.invoke('remote:set', email, password),
  remoteDisable: (email) => ipcRenderer.invoke('remote:disable', email),
  llmModels: () => ipcRenderer.invoke('llm:models'),
  llmUnload: (model) => ipcRenderer.invoke('llm:unload', model),
  llmChat: (id, request) => ipcRenderer.invoke('llm:chat', id, request),
  llmAbort: (id) => ipcRenderer.send('llm:abort', id),
  onLlmDelta: (listener) => {
    const handler = (_event, id, text) => listener(id, text);
    ipcRenderer.on('llm:delta', handler);
    return () => ipcRenderer.removeListener('llm:delta', handler);
  },
  // App updates: the page sees the state and asks; the Mac app does the fetching.
  updater: {
    state: () => ipcRenderer.invoke('updater:state'),
    info: () => ipcRenderer.invoke('updater:info'),
    check: () => ipcRenderer.invoke('updater:check'),
    download: () => ipcRenderer.invoke('updater:download'),
    install: () => ipcRenderer.invoke('updater:install'),
    setAuto: (on) => ipcRenderer.invoke('updater:setAuto', on === true),
    onState: (cb) => {
      const handler = (_e, state) => cb(state);
      ipcRenderer.on('updater:state', handler);
      return () => ipcRenderer.removeListener('updater:state', handler);
    },
  },
});
