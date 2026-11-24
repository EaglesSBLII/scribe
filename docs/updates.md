# Updating

The Mac app updates itself, the same way Chilaka does. You do not delete the app and download it again.

## How it works

- About 15 seconds after launch, and every 6 hours while it is open, the Mac app asks GitHub for the latest release of `EaglesSBLII/scribe`.
- If that release has a higher version than the app, a small notice appears at the top of the window and Settings shows it under "App update".
- "Download update" fetches the release's `.dmg` with a real percentage. The app then opens the disk image itself, copies `Scribe.app` out into a temporary folder and closes the image. Nothing has changed yet.
- "Restart to finish" moves the running app aside, copies the new one into the same place, deletes the old one and starts the new one. If the copy fails, the old app is put back.
- "Download updates automatically" (off by default, stored in `updater.json` in the app's data folder) starts the download without asking. Restarting is still your choice. With it on, a downloaded update is also put in place when you quit, ready for the next launch.
- Essays, accounts and settings live in the app's data folder, not in the app, so an update never touches them.

The code is `desktop/src/updater.js`. It is written by hand, with no extra package, and uses only tools every Mac has (`hdiutil`, `ditto`).

## What it contacts

This is the only thing in Scribe that goes online.

- `https://api.github.com/repos/EaglesSBLII/scribe/releases/latest` to read the version number, the notes and the list of files.
- The `.dmg` on that release. The address must start with `https://github.com/EaglesSBLII/scribe/releases/download/`, or it is refused. GitHub then hands the download to its own file servers.

The requests come from the Mac app's main process and carry the name `scribe-updater` and nothing else: no account, no essay text, no identifier. The page that shows your essays is still blocked from every network address. A background check that fails (no internet) says nothing; only a check you ask for reports a problem.

In a development run (`npm run desktop`) the updater does nothing.

## Publishing a release

1. Raise `version` in `desktop/package.json` (for example `0.3.0`). That number is what the app compares. Keep the root and `app/` versions in step for tidiness.
2. Build: `npm run dist:mac`. The result is `desktop/dist-electron/Scribe-0.3.0-arm64.dmg`. The build signs the app ad-hoc (`desktop/scripts/adhoc-sign.js`); check with `codesign -dv desktop/dist-electron/mac-arm64/Scribe.app`, which should print `Signature=adhoc` and `Identifier=com.scribe.essay`.
3. On GitHub, create a release in `EaglesSBLII/scribe` with the tag `v0.3.0` (the `v` is optional) and attach the dmg. Whatever you write as the description is kept as the release notes.

What the updater needs from the release:

- The tag is the version, and it matches the version inside the app. If they differ the update is refused, because the app would otherwise offer the same update for ever.
- One file whose name ends in `.dmg`, with `Scribe.app` at the top of the disk image. If there are several, the one with `arm64` in its name is used. The name electron-builder gives it (`Scribe-0.3.0-arm64.dmg`) is fine as it is. No zip, no `latest-mac.yml`.
- The release is published, not a draft and not marked as a pre-release. GitHub's "latest" skips those.
- The repository is public. GitHub limits one file to 2 GB; the dmg is about 1 GB.

The copy of Scribe 0.2.0 that was installed before the updater existed cannot update itself. Install the first version that has the updater by hand, once. From then on it updates from inside the app.

## Testing

Two environment variables, as in Chilaka:

- `SCRIBE_UPDATE_TEST=0.0.1` makes the app believe it is that old, and switches the updater on in a development run.
- `SCRIBE_UPDATE_FEED=<url>` reads the release information from another address instead of GitHub. The dmg may then come from anywhere, so the tests can serve it from this Mac.

The tests:

```sh
npm run build      # the banner and the Settings card are part of the web bundle
npm run smoke      # every test in desktop/tests
```

Or one file: `cd desktop && npx playwright test tests/update-flow.spec.mjs`.

- `desktop/tests/updater.spec.mjs` checks, on small fake apps inside real Electron, that a bundle is deleted, copied out of a disk image and swapped in correctly, and put back when the swap fails.
- `desktop/tests/update-flow.spec.mjs` serves a fake release 9.9.9 from `127.0.0.1` and follows it from "available" through the percentage to "ready", first through the app's bridge and then through the banner and the Settings card. The second part is skipped until the web bundle has been built. Nothing is replaced: a development run refuses to.

To look at the real thing by hand against GitHub, with a release published:

```sh
SCRIBE_UPDATE_TEST=0.0.1 /Applications/Scribe.app/Contents/MacOS/Scribe
```

Pressing Restart there really does replace that copy with the published one.

## Things to know

- An update needs about three and a half times the size of the download in free space for a few minutes (the dmg, the staged copy, and the old app while the new one is copied in). The app checks first and says so if there is not enough.
- Scribe has to be somewhere it can write to, such as the Applications folder. If it is run straight from the disk image or from the Downloads folder, macOS may run it from a read-only place, and the app will say to move it first.
- The app is signed ad-hoc, with no Apple developer certificate. macOS ties the microphone permission of such an app to the exact build, so it may ask for the microphone again after an update.
