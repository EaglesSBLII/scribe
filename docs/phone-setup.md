# Scribe on your iPhone

Your Mac stays the brain: Whisper, the counselor model and the voice all run there. The iPhone runs the same Scribe app in Safari (installable to the Home Screen), keeps its own copy of your essays, and talks to the Mac over a private connection.

## How it is kept private

- Scribe's server listens on the Mac's own address only (`127.0.0.1`). It is never opened to your Wi-Fi or to the internet.
- A private tunnel carries your phone to that address. Only devices signed in to **your** tunnel account can reach it.
- On top of that, any request that did not start on the Mac must sign in with a password you set on the Mac. Until you set one, other devices get nothing. Five wrong passwords lock sign-in for 15 minutes. The password is stored only as a salted hash.
- Phone access can be switched on, changed or switched off only from the Mac. Switching it off signs every device out.

## Proposed tunnel: Tailscale (free Personal plan) — needs your approval

**Nothing has been installed.** This is the proposal; say yes and the Mac half can be set up with you.

Why Tailscale: free for personal use, open-source client, no router changes, works from anywhere (home Wi-Fi, mobile data), and gives the phone a real HTTPS address, which Safari requires before it will allow the microphone. Traffic goes device to device, encrypted (WireGuard); Tailscale's servers only help the two devices find each other.

What it involves:

- Installing the Tailscale app on the Mac and on the iPhone, and a free Tailscale account (sign-in with Apple, Google or GitHub). That account is the one outside service in this setup; Scribe itself still sends nothing anywhere.
- One command on the Mac that forwards your private HTTPS address to Scribe.

Alternatives, if you would rather not: home Wi-Fi only (no account, but Safari will not allow the microphone without HTTPS, so it would need a self-made certificate installed on the phone); or ZeroTier / plain WireGuard (free, more setup, same HTTPS problem).

## Steps (after you approve)

1. **Mac:** install Tailscale from https://tailscale.com/download and sign in.
2. **iPhone:** install Tailscale from the App Store and sign in to the same account. Leave it switched on.
3. **Tailscale admin page → DNS:** switch on *MagicDNS* and *HTTPS Certificates*.
4. **Mac:** start Scribe (`npm start`, or open Scribe.app), then run:

   ```bash
   tailscale serve --bg 4310
   ```

   It prints an address like `https://your-mac.your-tailnet.ts.net`. That address works only on your own devices. (If the command is not found, it is inside the app: `/Applications/Tailscale.app/Contents/MacOS/Tailscale serve --bg 4310`.)

   Do **not** use `tailscale funnel`: that would publish the address to the internet.
5. **Mac, in Scribe:** Settings → Phone access → choose a password → Turn on.
6. **Check it asks for sign-in.** On the iPhone, open the address from step 4 followed by `/api/session`. It must show `"local":false`. If it shows `"local":true`, stop: the tunnel is not marking the phone as another device, so run `tailscale serve --https=443 off` and do not use it until that is fixed.
7. **iPhone, in Safari:** open the address from step 4, sign in with your Scribe email and that password, then Share → **Add to Home Screen**.

To stop: `tailscale serve --https=443 off` on the Mac, or Settings → Phone access → Turn off in Scribe.

## Using it

- Tap once anywhere first: iOS only lets a page play sound and use the microphone after a tap. Allow the microphone when asked.
- The large round button at the bottom starts and stops dictation. The wake word works too (switch on “Jarvis” in the toolbar) while Scribe is open and on screen.
- **iOS does not let a web app listen in the background.** When you switch apps or lock the phone, Scribe stops listening; open it again and tap the microphone.
- The ring/silent switch can mute sounds made by web apps. If you hear nothing, check it.
- Essays are a drawer (the menu button, top left). The counselor opens as a sheet from the bottom.

## Away from the Mac

If the Mac cannot be reached (it is asleep, or the phone has no signal), you can still open Scribe and dictate into an essay. Scribe shows “Offline…”, keeps each recording on the phone, and when the Mac is reachable again transcribes them there in order and puts the text into the essay you recorded it for. The wake word, voice commands and the counselor need the Mac and wait until you are connected.

The Mac must be awake and running Scribe for the phone to reach it.

## What syncs

Essays, counselor conversations, brainstorm stories, your voice memory and settings sync through the Mac. If the same essay was changed on two devices, the newer change wins and the other text is saved in that device's version history first (“Before an update from another device”). Undo history and saved versions stay on the device that made them; grades and uploaded paper formats are not synced.

The browser version and the Mac app each keep the master copy in their own place (`data/` in this folder for `npm start`, the app's own data folder for Scribe.app), so use one of them as the phone's partner, not both at once.
