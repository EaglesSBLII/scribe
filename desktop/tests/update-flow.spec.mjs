// The update as the writer sees it: a newer release is announced, Download
// brings it down with a real percentage, and Restart appears once the new
// bundle is staged. The release feed and the installer (a small real dmg,
// sent slowly so the progress can be watched) come from a server on this Mac.
// Nothing is installed: in a development run the app refuses to replace itself.
//
// The first test talks to the updater through the preload bridge and needs no
// particular web bundle. The second drives the banner and the Settings card, so
// it needs a web bundle built with them: run `npm run build` first.
import { test, expect, _electron as electron } from '@playwright/test';
import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const desktop = path.resolve(here, '..');
const thisVersion = JSON.parse(fs.readFileSync(path.join(desktop, 'package.json'), 'utf8')).version;

/** A fake release 9.9.9 served on 127.0.0.1, and the app started against it as if it were 0.0.1. */
async function launchWithRelease(port) {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'scribe-fake-release-'));
  // a stand-in Scribe.app with about 24 MB that cannot be compressed, inside a real dmg
  const contents = path.join(work, 'src', 'Scribe.app', 'Contents');
  fs.mkdirSync(path.join(contents, 'MacOS'), { recursive: true });
  fs.writeFileSync(
    path.join(contents, 'Info.plist'),
    '<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleShortVersionString</key>\n<string>9.9.9</string></dict></plist>',
  );
  fs.writeFileSync(path.join(contents, 'MacOS', 'padding.bin'), randomBytes(24 * 1024 * 1024));
  const dmg = path.join(work, 'Scribe-9.9.9-arm64.dmg');
  execFileSync('hdiutil', ['create', '-quiet', '-srcfolder', path.join(work, 'src'), '-volname', 'Scribe', '-format', 'UDZO', dmg]);
  const bytes = fs.readFileSync(dmg);
  const size = bytes.length;

  const asked = [];
  const server = createServer((req, res) => {
    asked.push({ url: req.url, agent: req.headers['user-agent'], cookie: req.headers.cookie ?? null, body: Number(req.headers['content-length'] ?? 0) });
    if (req.url === '/latest') {
      res.setHeader('content-type', 'application/json');
      res.end(
        JSON.stringify({
          tag_name: 'v9.9.9',
          body: 'Test release',
          assets: [{ name: 'Scribe-9.9.9-arm64.dmg', size, browser_download_url: `http://127.0.0.1:${server.address().port}/dmg` }],
        }),
      );
      return;
    }
    if (req.url === '/dmg') {
      // about 8 MB a second: a few seconds of visible progress
      res.setHeader('content-length', String(size));
      let off = 0;
      const tick = () => {
        if (off >= size) return res.end();
        res.write(bytes.subarray(off, (off += 512 * 1024)));
        setTimeout(tick, 60);
      };
      tick();
      return;
    }
    res.statusCode = 404;
    res.end();
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const feed = `http://127.0.0.1:${server.address().port}/latest`;

  const env = { ...process.env, SCRIBE_PORT: String(port), SCRIBE_UPDATE_TEST: '0.0.1', SCRIBE_UPDATE_FEED: feed };
  delete env.ELECTRON_RUN_AS_NODE;
  // a data folder of its own, so the test never touches the installed app's essays or settings
  const userData = path.join(work, 'userData');
  const app = await electron.launch({ args: [desktop, `--user-data-dir=${userData}`], env });
  const page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  const close = async () => {
    await app.close();
    server.close();
    fs.rmSync(work, { recursive: true, force: true });
  };
  return { app, page, feed, asked, userData, close };
}

/** The percentages must really move, reach well past half way, and never go backwards. */
function expectRealProgress(percents) {
  const seen = [...new Set(percents)];
  expect(seen.length).toBeGreaterThan(2);
  expect(Math.max(...seen)).toBeGreaterThanOrEqual(50);
  expect(percents).toEqual([...percents].sort((a, b) => a - b));
}

test('the Mac app finds a release, downloads it with real progress and stages it', async () => {
  test.setTimeout(180_000);
  const { app, page, feed, asked, userData, close } = await launchWithRelease(4315);
  try {
    // collect everything the updater reports to the page
    await page.evaluate(() => {
      window.updateStates = [];
      window.scribeBridge.updater.onState((s) => window.updateStates.push(s));
    });
    const phase = () => page.evaluate(() => window.scribeBridge.updater.state().then((s) => s.phase));
    const info = await page.evaluate(() => window.scribeBridge.updater.info());
    expect(info).toEqual({ enabled: true, current: thisVersion, auto: false });

    // the first check runs a moment after launch; with automatic downloads off it stops at "available"
    await expect.poll(phase, { timeout: 30_000 }).toBe('available');
    const offered = await page.evaluate(() => window.scribeBridge.updater.state());
    expect(offered).toMatchObject({ phase: 'available', version: '9.9.9', notes: 'Test release', percent: 0 });
    expect(offered.size).toBeGreaterThan(20 * 1024 * 1024);
    await page.waitForTimeout(1000);
    expect(await phase()).toBe('available');

    await page.evaluate(() => window.scribeBridge.updater.download());
    await expect.poll(phase, { timeout: 90_000, intervals: [200] }).toBe('ready');
    const states = await page.evaluate(() => window.updateStates);
    const downloading = states.filter((s) => s.phase === 'downloading');
    expectRealProgress(downloading.map((s) => s.percent));
    expect(downloading.at(-1).received).toBe(offered.size);
    expect(states.at(-1)).toMatchObject({ phase: 'ready', version: '9.9.9', percent: 100 });

    // the requests carried a plain name and nothing else: no cookies, no body, nothing about the writer
    expect(asked.map((r) => r.url)).toEqual(['/latest', '/dmg']);
    for (const r of asked) expect(r).toMatchObject({ agent: 'scribe-updater', cookie: null, body: 0 });

    // the page itself is still shut off from the network, even from the address the app just used
    const blocked = await page.evaluate((url) => fetch(url).then(() => 'reached', () => 'blocked'), feed);
    expect(blocked).toBe('blocked');

    // Restart in a development run replaces nothing and says so
    await page.evaluate(() => window.scribeBridge.updater.install());
    await expect.poll(phase).toBe('error');
    expect((await page.evaluate(() => window.scribeBridge.updater.state())).error).toContain('development run');
    expect(await app.evaluate(({ app: a }) => a.getVersion())).toBe(thisVersion);

    // the automatic-download switch is remembered in <userData>/updater.json
    expect(await page.evaluate(() => window.scribeBridge.updater.setAuto(true))).toBe(true);
    expect(JSON.parse(fs.readFileSync(path.join(userData, 'updater.json'), 'utf8'))).toEqual({ auto: true });
  } finally {
    await close();
  }
});

// The banner and the Settings card live in the web bundle. Skipped until it has been rebuilt with them.
const assets = path.resolve(desktop, '..', 'app', 'dist', 'assets');
const built = fs.existsSync(assets) && fs.readdirSync(assets).some((f) => f.endsWith('.js') && fs.readFileSync(path.join(assets, f), 'utf8').includes('update-banner'));

test('banner says an update is available, Settings downloads it with a percentage, then Restart is offered', async () => {
  test.skip(!built, 'The web bundle in app/dist has no update banner yet. Run `npm run build` in the repo root first.');
  test.setTimeout(180_000);
  const { app, page, close } = await launchWithRelease(4316);
  try {
    await page.getByLabel('Your email').fill('writer@example.com');
    await page.getByRole('button', { name: 'Create account' }).click();

    const banner = page.getByTestId('update-banner');
    await expect(banner).toHaveAttribute('data-phase', 'available', { timeout: 30_000 });
    await expect(banner).toContainText('Scribe 9.9.9 is available');
    await expect(banner.getByRole('button', { name: 'Update' })).toBeVisible();
    await page.screenshot({ path: path.join(desktop, 'test-results', 'update-1-available.png') });

    await page.getByRole('navigation').getByRole('button', { name: 'Settings' }).click();
    const card = page.getByTestId('update-card');
    await card.scrollIntoViewIfNeeded();
    await expect(card).toContainText('Scribe 9.9.9 is available');
    await expect(card).toContainText(`You have ${thisVersion}`);
    await expect(card).toContainText('the only time Scribe contacts the internet');
    await expect(card.getByLabel('Download updates automatically')).not.toBeChecked();
    await card.getByRole('button', { name: 'Download update' }).click();
    await expect(card).toHaveAttribute('data-phase', 'downloading', { timeout: 10_000 });

    const percents = [];
    const started = Date.now();
    while (Date.now() - started < 60_000) {
      if ((await card.getAttribute('data-phase')) !== 'downloading') break;
      const text = await page.getByTestId('update-percent').textContent({ timeout: 1000 }).catch(() => null);
      if (text) percents.push(Number(text.replace('%', '')));
      if (percents.length === 5) await page.screenshot({ path: path.join(desktop, 'test-results', 'update-2-downloading.png') });
      await page.waitForTimeout(150);
    }
    expectRealProgress(percents);

    await expect(card).toHaveAttribute('data-phase', 'ready', { timeout: 60_000 });
    await expect(card).toContainText('Scribe 9.9.9 is ready');
    await expect(card.getByRole('button', { name: 'Restart to finish' })).toBeVisible();
    await expect(banner).toHaveAttribute('data-phase', 'ready');
    await expect(banner.getByRole('button', { name: 'Restart' })).toBeVisible();
    await page.screenshot({ path: path.join(desktop, 'test-results', 'update-3-ready.png') });
    // staged, not installed: the running app is untouched
    expect(await app.evaluate(({ app: a }) => a.getVersion())).toBe(thisVersion);
  } finally {
    await close();
  }
});
