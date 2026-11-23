// Scribe's Mac shell. It shows the same web bundle as the browser version and
// gives it local Whisper through the preload bridge. It never goes online.
const { app, BrowserWindow, ipcMain, session, systemPreferences } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const isDev = !app.isPackaged;
const resources = isDev ? path.join(__dirname, '..', 'resources') : process.resourcesPath;
// Packaged builds carry a copy in lib/; in development the shared code is used directly.
const bundledLib = path.join(__dirname, '..', 'lib');
const libDir = !isDev && fs.existsSync(path.join(bundledLib, 'whisper.js')) ? bundledLib : path.join(__dirname, '..', '..', 'local');
const { createWhisper } = require(path.join(libDir, 'whisper.js'));
const ollama = require(path.join(libDir, 'ollama.js'));

const whisper = createWhisper(resources);
const { createTts } = require(path.join(libDir, 'tts.js'));
const tts = createTts(resources);
let win = null;

function indexFile() {
  const packaged = path.join(__dirname, '..', 'web', 'index.html');
  return !isDev && fs.existsSync(packaged) ? packaged : path.join(__dirname, '..', '..', 'app', 'dist', 'index.html');
}

function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 900,
    minHeight: 600,
    title: 'Scribe',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  // The window only ever shows Scribe's own files.
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.loadFile(indexFile());
  win.on('closed', () => { win = null; });
}

app.whenReady().then(() => {
  // Refuse every request that is not one of the app's own files.
  session.defaultSession.webRequest.onBeforeRequest((details, done) => {
    const ok = /^(file|devtools|blob|data|chrome-extension):/.test(details.url);
    done({ cancel: !ok });
  });
  session.defaultSession.setPermissionRequestHandler((_wc, permission, done) => done(permission === 'media'));
  session.defaultSession.setPermissionCheckHandler((_wc, permission) => permission === 'media');

  ipcMain.handle('asr:available', () => whisper.available());
  ipcMain.handle('tts:info', () => ({ available: tts.available(), voices: tts.voices, defaultVoice: tts.defaultVoice }));
  ipcMain.handle('tts:speak', async (_e, text, voice, speed) => {
    const audio = await tts.synth(String(text ?? ''), voice, speed);
    // Hand the page the bytes of the WAV file.
    return audio.wav.buffer.slice(audio.wav.byteOffset, audio.wav.byteOffset + audio.wav.byteLength);
  });
  ipcMain.handle('asr:transcribe', async (_e, wav) => {
    if (process.platform === 'darwin') await systemPreferences.askForMediaAccess('microphone').catch(() => false);
    return whisper.transcribe(Buffer.from(wav));
  });

  // The counselor model: Ollama on this machine, reached from the main process only.
  const running = new Map();
  ipcMain.handle('llm:models', () => ollama.models());
  ipcMain.handle('llm:unload', (_e, model) => ollama.unload(String(model)));
  ipcMain.handle('llm:chat', async (event, id, request) => {
    const abort = new AbortController();
    running.set(id, abort);
    try {
      return await ollama.chat(request, (text) => event.sender.send('llm:delta', id, text), abort.signal);
    } finally {
      running.delete(id);
    }
  });
  ipcMain.on('llm:abort', (_e, id) => running.get(id)?.abort());

  createWindow();
  // Load the speech model shortly after launch so the first sentence is not slow.
  if (whisper.available()) setTimeout(() => whisper.start().catch((e) => console.error(e.message)), 1500);
  app.on('activate', () => { if (!win) createWindow(); });
});

app.on('window-all-closed', () => app.quit());
app.on('will-quit', () => {
  whisper.stop();
  tts.stop();
});
