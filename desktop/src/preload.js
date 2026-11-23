// The only doorway between the page and the Mac app.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('scribeBridge', {
  asrAvailable: () => ipcRenderer.invoke('asr:available'),
  ttsInfo: () => ipcRenderer.invoke('tts:info'),
  ttsSpeak: (text, voice, speed) => ipcRenderer.invoke('tts:speak', text, voice, speed),
  asrTranscribe: (wav) => ipcRenderer.invoke('asr:transcribe', wav),
  llmModels: () => ipcRenderer.invoke('llm:models'),
  llmUnload: (model) => ipcRenderer.invoke('llm:unload', model),
  llmChat: (id, request) => ipcRenderer.invoke('llm:chat', id, request),
  llmAbort: (id) => ipcRenderer.send('llm:abort', id),
  onLlmDelta: (listener) => {
    const handler = (_event, id, text) => listener(id, text);
    ipcRenderer.on('llm:delta', handler);
    return () => ipcRenderer.removeListener('llm:delta', handler);
  },
});
