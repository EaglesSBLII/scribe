// Self-updater for the Mac app, modelled on Chilaka's. It looks at the GitHub
// release feed of the public Scribe repository shortly after launch and every
// few hours, and tells the window when a newer version exists. The writer
// presses Download: the installer comes down with live progress, the new
// bundle is staged, and Restart swaps it in. With "download updates
// automatically" on, the download starts by itself and only the restart is
// manual.
//
// This is the only part of Scribe that goes online. It runs in the main
// process, sends nothing but a plain request for the release list and the
// installer, and never touches essays or accounts. The page stays offline.
//
// No signing identity is needed: the app is ad-hoc signed, and a bundle the app
// copies into place itself carries no quarantine flag.
//
// State pushed to the window (onState): { phase, version, notes, size, received,
// percent, error } with phase one of idle | checking | up-to-date | available |
// downloading | ready | error.
//
// Settings live in <userData>/updater.json: { auto: false }.
// QA: SCRIBE_UPDATE_TEST=0.0.1 makes the build think it is that old;
// SCRIBE_UPDATE_FEED=<url> reads the release JSON from somewhere else.

const { app } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { execFile, execFileSync } = require('node:child_process');
const { promisify } = require('node:util');

const run = promisify(execFile);

const REPO = 'EaglesSBLII/scribe';
const NAME = 'Scribe';
const TEST_VERSION = process.env.SCRIBE_UPDATE_TEST || '';
const TEST_FEED = process.env.SCRIBE_UPDATE_FEED || '';
const FEED = TEST_FEED || `https://api.github.com/repos/${REPO}/releases/latest`;
// A real release is only ever downloaded from this repository's release page.
const ASSET_PREFIX = `https://github.com/${REPO}/releases/download/`;
const HEADERS = { 'user-agent': 'scribe-updater' };
const CHECK_EVERY_MS = 6 * 60 * 60 * 1000;
const STAGE_PREFIX = 'scribe-update-';

/** Remove a bundle the way Finder would. Node's fs inside Electron treats
 *  app.asar as a directory, so fs.rmSync(recursive) fails with ENOTDIR on it. */
function removeBundle(p) {
  if (!fs.existsSync(p)) return;
  execFileSync('rm', ['-rf', p]);
}

function cmp(a, b) {
  const pa = String(a).split('.').map((n) => parseInt(n, 10));
  const pb = String(b).split('.').map((n) => parseInt(n, 10));
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d;
  }
  return 0;
}

/** The version written inside a bundle on disk, or null. */
function bundleVersion(bundle) {
  try {
    const plist = fs.readFileSync(path.join(bundle, 'Contents', 'Info.plist'), 'utf8');
    return /<key>CFBundleShortVersionString<\/key>\s*<string>([^<]+)<\/string>/.exec(plist)?.[1] || null;
  } catch {
    return null;
  }
}

/** Mount the installer, copy Scribe.app out of it into `dir`, unmount. Returns the copy's path. */
async function stageFromDmg(dmg, dir) {
  const mount = path.join(dir, 'mnt');
  fs.mkdirSync(mount, { recursive: true });
  await run('hdiutil', ['attach', '-nobrowse', '-quiet', '-readonly', '-mountpoint', mount, dmg]);
  try {
    const src = path.join(mount, `${NAME}.app`);
    if (!fs.existsSync(src)) throw new Error(`The installer has no ${NAME}.app in it.`);
    const staged = path.join(dir, `${NAME}.app`);
    await run('ditto', [src, staged]);
    return staged;
  } finally {
    await run('hdiutil', ['detach', '-quiet', mount]).catch(() => run('hdiutil', ['detach', '-force', '-quiet', mount]).catch(() => {}));
  }
}

/** Put `staged` where `target` is. The current app waits in `<target>.previous`
 *  while the copy runs and is put back if the copy fails, so there is always an
 *  app at `target`. Synchronous, so it can also run while the app quits. */
function swapBundle(staged, target) {
  const backup = `${target}.previous`;
  let moved = false; // true only while the current app sits in `backup`
  try {
    removeBundle(backup);
    fs.renameSync(target, backup);
    moved = true;
    execFileSync('ditto', [staged, target]);
    moved = false;
  } catch (err) {
    if (moved) {
      try {
        removeBundle(target);
        fs.renameSync(backup, target);
      } catch {
        /* nothing more we can do */
      }
    }
    throw err;
  }
  // the new app is in place; a leftover backup must never block the relaunch
  try {
    removeBundle(backup);
  } catch {
    /* cleaned up on the next update */
  }
}

/** Errors in plain words. Our own messages are sentences already. */
function plain(err) {
  const msg = String(err?.message || err);
  const code = err?.code || err?.cause?.code || '';
  if (msg === 'fetch failed' || /ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN|ENETUNREACH|UND_ERR/.test(`${code} ${msg}`)) {
    return 'Could not reach GitHub. Check the internet connection and try again.';
  }
  if (/EACCES|EPERM|EROFS/.test(`${code} ${msg}`)) {
    return 'Scribe is not allowed to replace itself where it is. Move Scribe to the Applications folder, open it from there and try again.';
  }
  if (/ENOSPC/.test(`${code} ${msg}`)) return 'There is not enough free space on this Mac for the update.';
  return msg;
}

class Updater {
  constructor() {
    this.file = path.join(app.getPath('userData'), 'updater.json');
    this.settings = { auto: false };
    try {
      this.settings = { ...this.settings, ...JSON.parse(fs.readFileSync(this.file, 'utf8')) };
    } catch {
      /* first run */
    }
    this.available = null; // { version, url, size, digest, notes }
    this.staged = null; // path to the new Scribe.app, ready to swap in
    this.stagedVersion = null;
    this.swapped = false; // the new app is already in place; only a restart is missing
    this.busy = false;
    this.timer = null;
    this.onState = () => {};
    /** Called just before the app restarts into the new version (stop helpers here). */
    this.beforeRelaunch = () => {};
    this.state = { phase: 'idle' };
  }

  /** Updates run in the packaged Mac app only, or when a test asks for them. */
  get enabled() {
    return process.platform === 'darwin' && (app.isPackaged || Boolean(TEST_VERSION));
  }

  get auto() {
    return this.settings.auto === true;
  }

  /** What the settings card shows besides the state. */
  info() {
    return { enabled: this.enabled, current: app.getVersion(), auto: this.auto };
  }

  /** Replace the public state and tell the window. */
  setState(patch) {
    this.state = { ...this.state, ...patch };
    this.onState(this.state);
    return this.state;
  }

  setAuto(on) {
    this.settings.auto = Boolean(on);
    try {
      fs.writeFileSync(this.file, JSON.stringify(this.settings));
    } catch {
      /* kept for this run only */
    }
    if (this.settings.auto && this.enabled) void this.check();
    return this.auto;
  }

  /** The running bundle (…/Scribe.app), wherever the writer keeps it. */
  bundlePath() {
    const exe = app.getPath('exe'); // …/Scribe.app/Contents/MacOS/Scribe
    return path.resolve(exe, '..', '..', '..');
  }

  start() {
    if (!this.enabled) return;
    if (app.isPackaged) this.sweep();
    setTimeout(() => void this.check(), TEST_VERSION ? 1500 : 15_000);
    this.timer = setInterval(() => void this.check(), CHECK_EVERY_MS);
  }

  /** Delete downloads left behind by an earlier run. A staged copy is about 1 GB. */
  sweep() {
    try {
      for (const name of fs.readdirSync(os.tmpdir())) {
        if (name.startsWith(STAGE_PREFIX)) removeBundle(path.join(os.tmpdir(), name));
      }
    } catch {
      /* not worth failing a launch over */
    }
  }

  /** Look for a newer release. A check the writer asked for (manual) reports
   *  problems; the quiet ones in the background do not, because Scribe is
   *  often used with no internet at all. */
  async check(manual = false) {
    if (!this.enabled || this.busy || this.swapped) return;
    this.busy = true;
    const before = this.state.phase;
    if (before !== 'ready') this.setState({ phase: 'checking', error: undefined });
    try {
      // (packaged only: in a development launch the bundle on disk is Electron itself)
      const onDisk = app.isPackaged ? bundleVersion(this.bundlePath()) : null;
      if (onDisk && cmp(onDisk, app.getVersion()) > 0) {
        // the new app is already installed under this (old) process: only a restart is missing
        this.swapped = true;
        this.setState({ phase: 'ready', version: onDisk, percent: 100 });
        return;
      }
      const res = await fetch(FEED, { headers: { ...HEADERS, accept: 'application/vnd.github+json' } });
      if (res.status === 404) throw new Error('No Scribe release has been published yet.');
      if (res.status === 403 || res.status === 429) throw new Error('GitHub is not answering right now. Try again in an hour.');
      if (!res.ok) throw new Error(`GitHub answered with an error (${res.status}). Try again later.`);
      const rel = await res.json();
      const version = String(rel.tag_name || '').replace(/^v/, '');
      const dmgs = (rel.assets || []).filter((a) => /\.dmg$/i.test(a.name || ''));
      const asset = dmgs.find((a) => /arm64/i.test(a.name)) || dmgs[0];
      if (!version || !asset) throw new Error('The latest release has no Mac installer (.dmg) attached.');
      const url = String(asset.browser_download_url || '');
      if (!TEST_FEED && !url.startsWith(ASSET_PREFIX)) throw new Error('The latest release points somewhere unexpected, so it was not downloaded.');
      // SCRIBE_UPDATE_TEST=0.0.1 makes a build think it is that old (QA of the update path)
      const current = TEST_VERSION || app.getVersion();
      if (cmp(version, current) <= 0) {
        this.available = null;
        this.setState({ phase: 'up-to-date', version: undefined, notes: undefined });
        return;
      }
      const notes = String(rel.body || '');
      if (this.staged && this.stagedVersion === version) {
        this.setState({ phase: 'ready', version, notes, percent: 100 });
        return;
      }
      const digest = /^sha256:[0-9a-f]{64}$/i.test(asset.digest || '') ? asset.digest.slice(7).toLowerCase() : null;
      this.available = { version, url, size: Number(asset.size) || 0, digest, notes };
      this.setState({ phase: 'available', version, notes, size: this.available.size, received: 0, percent: 0 });
    } catch (err) {
      if (manual) this.setState({ phase: 'error', error: plain(err) });
      else this.setState({ phase: before === 'ready' ? 'ready' : this.available ? 'available' : 'idle' });
    } finally {
      this.busy = false;
    }
    if (this.state.phase === 'available' && this.auto) void this.download();
  }

  /** The writer pressed Download (or auto-download is on): fetch and stage the new version. */
  async download() {
    if (!this.enabled || this.busy) return;
    if (!this.available) return this.check(true); // "Try again" after a failed check

    this.busy = true;
    try {
      await this.downloadAndStage();
      this.setState({ phase: 'ready', version: this.stagedVersion, percent: 100 });
    } catch (err) {
      this.setState({ phase: 'error', error: plain(err) });
    } finally {
      this.busy = false;
    }
  }

  /** Download the dmg to a temp folder and copy the app bundle out of it. */
  async downloadAndStage() {
    const u = this.available;
    if (!u || (this.staged && this.stagedVersion === u.version)) return;
    if (this.staged) removeBundle(path.dirname(this.staged)); // an older staged version
    this.staged = null;
    // room for the installer, the staged copy and the swap, all at once for a moment
    if (u.size) {
      const fsStat = fs.statfsSync(os.tmpdir());
      if (fsStat.bavail * fsStat.bsize < u.size * 3.5) {
        throw new Error(`There is not enough free space for the update. It needs about ${Math.ceil((u.size * 3.5) / 1e9)} GB for a few minutes.`);
      }
    }
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), STAGE_PREFIX));
    const dmg = path.join(dir, `${NAME}-${u.version}.dmg`);
    try {
      const res = await fetch(u.url, { headers: HEADERS });
      if (!res.ok || !res.body) throw new Error(`The download did not start (GitHub answered ${res.status}). Try again later.`);
      const total = u.size || Number(res.headers.get('content-length')) || 0;
      this.setState({ phase: 'downloading', version: u.version, size: total, received: 0, percent: 0, error: undefined });
      const out = fs.createWriteStream(dmg);
      const failed = new Promise((_, reject) => out.once('error', reject));
      failed.catch(() => {}); // reported through the races below
      const hash = crypto.createHash('sha256');
      const reader = res.body.getReader();
      let got = 0;
      let lastTick = 0;
      for (;;) {
        const { done, value } = await Promise.race([reader.read(), failed]);
        if (done) break;
        got += value.length;
        hash.update(value);
        if (!out.write(value)) await Promise.race([new Promise((r) => out.once('drain', r)), failed]);
        // ~5 updates a second is plenty for a progress bar
        const now = Date.now();
        if (now - lastTick > 200) {
          lastTick = now;
          this.setState({ received: got, percent: total ? Math.min(99, Math.floor((got / total) * 100)) : 0 });
        }
      }
      await Promise.race([new Promise((r) => out.end(r)), failed]);
      if (u.size && got !== u.size) throw new Error('The download stopped part way. Try again.');
      if (u.digest && hash.digest('hex') !== u.digest) throw new Error('The download arrived damaged. Try again.');
      // unpacking the installer is the last stretch; the bar sits at 99% until the bundle is staged
      this.setState({ received: got, percent: 99 });
      const staged = await stageFromDmg(dmg, dir);
      // a release whose app still carries an older version would be offered again for ever
      const inside = bundleVersion(staged);
      if (inside !== u.version) {
        throw new Error(`The release is labelled ${u.version} but the app inside it says ${inside || 'nothing'}. It was not installed.`);
      }
      fs.rmSync(dmg, { force: true });
      this.staged = staged;
      this.stagedVersion = u.version;
    } catch (err) {
      removeBundle(dir);
      throw err;
    }
  }

  /** Why the running app cannot be replaced, in plain words, or null when it can. */
  blocked() {
    if (!app.isPackaged) return 'This is a development run of Scribe, so nothing was replaced.';
    const target = this.bundlePath();
    if (path.basename(target) !== `${NAME}.app`) return 'Scribe could not find its own app to replace.';
    if (target.includes('/AppTranslocation/') || target.startsWith('/Volumes/')) {
      return 'Scribe is running from a temporary place. Move Scribe to the Applications folder, open it from there and try again.';
    }
    try {
      fs.accessSync(path.dirname(target), fs.constants.W_OK);
    } catch {
      return 'Scribe is not allowed to replace itself where it is. Move Scribe to the Applications folder, open it from there and try again.';
    }
    return null;
  }

  relaunch() {
    try {
      this.beforeRelaunch();
    } catch {
      /* restart anyway */
    }
    app.relaunch({ execPath: path.join(this.bundlePath(), 'Contents', 'MacOS', NAME) });
    app.exit(0);
  }

  /** Swap the staged bundle over the running one and relaunch. */
  async installAndRelaunch() {
    if (this.busy) return;
    if (this.swapped) return this.relaunch();
    if (!this.staged) return;
    const why = this.blocked() || (fs.existsSync(this.staged) ? null : 'The downloaded update is gone. Download it again.');
    if (why) {
      if (!fs.existsSync(this.staged)) this.staged = null;
      this.setState({ phase: 'error', error: why });
      return;
    }
    this.busy = true;
    try {
      swapBundle(this.staged, this.bundlePath());
    } catch (err) {
      this.busy = false;
      this.setState({ phase: 'error', error: `The update could not be put in place, so Scribe was left as it was. ${plain(err)}` });
      return;
    }
    try {
      removeBundle(path.dirname(this.staged));
    } catch {
      /* swept on the next launch */
    }
    this.staged = null;
    this.relaunch();
  }

  /** On quit: with automatic downloads on, a staged update is installed quietly for the next launch. */
  installStagedOnQuit() {
    if (!this.staged || !this.auto || this.swapped || this.blocked()) return;
    // the staged copy lives in the temp folder, which macOS may have purged
    if (!fs.existsSync(this.staged)) return;
    try {
      swapBundle(this.staged, this.bundlePath());
      removeBundle(path.dirname(this.staged));
      this.staged = null;
    } catch {
      /* the current version is still in place; offered again next time */
    }
  }
}

module.exports = { Updater, cmp, removeBundle, bundleVersion, stageFromDmg, swapBundle };
