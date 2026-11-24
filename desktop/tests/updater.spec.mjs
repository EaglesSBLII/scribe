// The updater's file handling, run inside the real Electron main process on
// small fake bundles. Nothing here goes online and the app itself is not touched.
//
// Why inside Electron: there, fs treats app.asar as a directory, so
// fs.rmSync(recursive) on a bundle dies with ENOTDIR (the bug Chilaka hit in
// its 0.2.1 and 0.3.0 updates). removeBundle must delete such a bundle cleanly.
import { test, expect, _electron as electron } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const desktop = path.resolve(here, '..');

test('the updater removes, stages and swaps app bundles safely', async () => {
  test.setTimeout(120_000);
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'scribe-updater-test-'));
  const env = { ...process.env, SCRIBE_PORT: '4314' };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.SCRIBE_UPDATE_TEST;
  delete env.SCRIBE_UPDATE_FEED;
  const app = await electron.launch({ args: [desktop, `--user-data-dir=${path.join(work, 'userData')}`], env });
  try {
    const result = await app.evaluate(async ({ app: electronApp }, { desktop, work }) => {
      // evaluate() runs outside any CommonJS module: build a require rooted at desktop/src
      const { createRequire } = process.getBuiltinModule('node:module');
      const require = createRequire(desktop + '/src/');
      const fs = require('node:fs');
      const path = require('node:path');
      const { execFileSync } = require('node:child_process');
      const { Updater, cmp, removeBundle, bundleVersion, stageFromDmg, swapBundle } = require(path.join(desktop, 'src', 'updater.js'));

      // A tiny but valid asar archive, written by hand (a size record, then a JSON index, then the files).
      const index = Buffer.from(JSON.stringify({ files: { 'main.js': { size: 8, offset: '0' } } }));
      const padded = Math.ceil(index.length / 4) * 4;
      const head = Buffer.alloc(16 + padded);
      head.writeUInt32LE(4, 0);
      head.writeUInt32LE(8 + padded, 4);
      head.writeUInt32LE(4 + padded, 8);
      head.writeUInt32LE(index.length, 12);
      index.copy(head, 16);
      const asar = path.join(work, 'fake.asar');
      // written under another name first: fs would already treat a path ending in .asar specially
      fs.writeFileSync(path.join(work, 'fake.bin'), Buffer.concat([head, Buffer.from('// stub\n')]));
      execFileSync('mv', [path.join(work, 'fake.bin'), asar]);

      /** A stand-in Scribe.app that says it is `version`. */
      const bundle = (dir, version, name = 'Scribe.app') => {
        const b = path.join(dir, name);
        fs.mkdirSync(path.join(b, 'Contents', 'Resources'), { recursive: true });
        fs.writeFileSync(
          path.join(b, 'Contents', 'Info.plist'),
          `<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleShortVersionString</key>\n<string>${version}</string></dict></plist>`,
        );
        execFileSync('cp', [asar, path.join(b, 'Contents', 'Resources', 'app.asar')]);
        return b;
      };
      const dir = (name) => {
        const d = path.join(work, name);
        fs.mkdirSync(d);
        return d;
      };

      // 1. removing a bundle that holds an app.asar
      let oldCode = 'no error';
      const b1 = bundle(dir('rm-old'), '1.0.0', 'Scribe.app.previous');
      try {
        fs.rmSync(b1, { recursive: true, force: true });
      } catch (e) {
        oldCode = e.code;
      }
      const b2 = bundle(dir('rm-new'), '1.0.0', 'Scribe.app.previous');
      removeBundle(b2);
      const removed = !fs.existsSync(b2);

      // 2. staging: the app is copied out of a real disk image, and the image is unmounted again
      const src = dir('dmg-src');
      bundle(src, '2.0.0');
      const dmg = path.join(work, 'Scribe-2.0.0-arm64.dmg');
      execFileSync('hdiutil', ['create', '-quiet', '-srcfolder', src, '-volname', 'Scribe', '-format', 'UDZO', dmg]);
      const stageDir = dir('stage');
      const staged = await stageFromDmg(dmg, stageDir);
      const stagedVersion = bundleVersion(staged);
      const stillMounted = fs.existsSync(path.join(stageDir, 'mnt', 'Scribe.app'));
      let emptyDmgError = '';
      const emptySrc = dir('empty-src');
      fs.writeFileSync(path.join(emptySrc, 'readme.txt'), 'no app here');
      const emptyDmg = path.join(work, 'empty.dmg');
      execFileSync('hdiutil', ['create', '-quiet', '-srcfolder', emptySrc, '-volname', 'Empty', '-format', 'UDZO', emptyDmg]);
      await stageFromDmg(emptyDmg, dir('stage-empty')).catch((e) => { emptyDmgError = e.message; });

      // 3. swapping: the staged copy takes the place of the installed one
      const installed = bundle(dir('Applications'), '1.0.0');
      fs.writeFileSync(path.join(installed, 'Contents', 'old-only.txt'), 'from 1.0.0');
      swapBundle(staged, installed);
      let quarantined = true;
      try {
        execFileSync('xattr', ['-p', 'com.apple.quarantine', installed], { stdio: 'ignore' });
      } catch {
        quarantined = false;
      }
      const swap = {
        version: bundleVersion(installed),
        oldFileGone: !fs.existsSync(path.join(installed, 'Contents', 'old-only.txt')),
        backupGone: !fs.existsSync(`${installed}.previous`),
        stagedKept: fs.existsSync(staged),
        quarantined,
      };

      // 4. a swap that fails half way puts the current app back
      const kept = bundle(dir('Applications2'), '1.0.0');
      let failed = false;
      try {
        swapBundle(path.join(work, 'does-not-exist', 'Scribe.app'), kept);
      } catch {
        failed = true;
      }
      const afterFailure = { failed, version: bundleVersion(kept), backupGone: !fs.existsSync(`${kept}.previous`) };

      // 5. in a development run with no test switch, the updater does nothing at all
      const idle = new Updater();
      idle.start();
      await idle.check(true);
      await idle.download();
      await idle.installAndRelaunch();

      return {
        running: Boolean(electronApp.isReady()),
        oldCode,
        removed,
        stagedVersion,
        stillMounted,
        emptyDmgError,
        swap,
        afterFailure,
        order: [cmp('0.2.0', '0.10.0') < 0, cmp('1.0.0', '1.0.0') === 0, cmp('0.3.0', '0.2.9') > 0, cmp('1.0', '1.0.1') < 0],
        idle: { enabled: idle.enabled, phase: idle.state.phase, timer: idle.timer, auto: idle.auto },
      };
    }, { desktop, work });

    expect(result.running).toBe(true);
    // the bug being guarded against really exists in this Electron
    expect(result.oldCode).toBe('ENOTDIR');
    expect(result.removed).toBe(true);
    expect(result.stagedVersion).toBe('2.0.0');
    expect(result.stillMounted).toBe(false);
    expect(result.emptyDmgError).toContain('no Scribe.app');
    expect(result.swap).toEqual({ version: '2.0.0', oldFileGone: true, backupGone: true, stagedKept: true, quarantined: false });
    expect(result.afterFailure).toEqual({ failed: true, version: '1.0.0', backupGone: true });
    expect(result.order).toEqual([true, true, true, true]);
    expect(result.idle).toEqual({ enabled: false, phase: 'idle', timer: null, auto: false });
  } finally {
    await app.close();
    // plain Node here, where an .asar is an ordinary file
    fs.rmSync(work, { recursive: true, force: true });
  }
});
