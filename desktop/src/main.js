// Scribe's Mac shell. It shows the same web bundle as the browser version and
// gives it local Whisper through the preload bridge. The page never goes online.
// The one thing that does is the updater (updater.js), from this process only:
// it asks GitHub whether a newer Scribe exists and downloads it when asked to.
const { app, BrowserWindow, ipcMain, session, systemPreferences, shell } = require('electron');
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
// The master copy for syncing, and sign-in for a phone (see local/remote.js).
const { createRemote } = require(path.join(libDir, 'remote.js'));
const { createHandler, listen } = require(path.join(libDir, 'server.js'));
const PHONE_PORT = Number(process.env.SCRIBE_PORT || 4310);
let remote = null;
let phoneServer = null;
let win = null;
const { Updater } = require('./updater');
const updater = new Updater();

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
    // The same near-black as the page, so the window never flashes white while it loads.
    backgroundColor: '#0a0a0b',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  // The window only ever shows Scribe's own files.
  // A link to a school's own website opens in the writer's browser, never in this window.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//i.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
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
  ipcMain.handle('asr:transcribe', async (_e, wav, quick) => {
    if (process.platform === 'darwin') await systemPreferences.askForMediaAccess('microphone').catch(() => false);
    return whisper.transcribe(Buffer.from(wav), { quick: quick === true });
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

  // Syncing and phone access. The window talks to the store directly; a phone
  // goes through a server that listens on this Mac only and requires sign-in.
  remote = createRemote(path.join(app.getPath('userData'), 'sync'));
  ipcMain.handle('sync:exchange', (_e, body) => remote.exchange(body?.email, body));
  ipcMain.handle('remote:status', (_e, email) => remote.status(email));
  ipcMain.handle('remote:set', (_e, email, password) => {
    try {
      remote.setPassword(email, password);
      return remote.status(email);
    } catch (err) {
      return { enabled: false, error: err.message };
    }
  });
  ipcMain.handle('remote:disable', (_e, email) => {
    remote.disable(email);
    return remote.status(email);
  });
  // App updates. The page only sees the state and three buttons; the requests are made here.
  updater.onState = (state) => {
    if (win && !win.isDestroyed()) win.webContents.send('updater:state', state);
  };
  updater.beforeRelaunch = stopServices;
  ipcMain.handle('updater:state', () => updater.state);
  ipcMain.handle('updater:info', () => updater.info());
  ipcMain.handle('updater:check', () => void updater.check(true));
  ipcMain.handle('updater:download', () => void updater.download());
  ipcMain.handle('updater:install', () => void updater.installAndRelaunch());
  ipcMain.handle('updater:setAuto', (_e, on) => updater.setAuto(on === true));
  updater.start();

  listen(createHandler({ dist: path.dirname(indexFile()), whisper, tts, ollama, remote }), PHONE_PORT).then(
    (server) => { phoneServer = server; },
    // The port is taken when Scribe is also running in the browser; that copy serves the phone instead.
    (err) => console.error(`Phone access is not being served by the app: ${err.message}`),
  );

  createWindow();
  // Load the speech model shortly after launch so the first sentence is not slow.
  if (whisper.available()) setTimeout(() => whisper.start().catch((e) => console.error(e.message)), 1500);
  app.on('activate', () => { if (!win) createWindow(); });
});

app.on('window-all-closed', () => app.quit());
function stopServices() {
  phoneServer?.close();
  whisper.stop();
  tts.stop();
}
app.on('before-quit', () => updater.installStagedOnQuit());
app.on('will-quit', stopServices);
