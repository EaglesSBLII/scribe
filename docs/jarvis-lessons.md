# Lessons from the OpenJarvis voice assistant

Written 22 November 2026, before OpenJarvis was removed, so that Scribe's voice pipeline starts from what that project learned. Scribe reuses these lessons, not its personality: "Jarvis" is only the wake word.

**What it was.** A fully local assistant set up on 15 November 2026: Stanford's OpenJarvis (`~/.openjarvis`, server on `127.0.0.1:8000`) plus a custom listener, `~/jarvis-wake/hey_jarvis.py` (1,226 lines), started by `~/.local/bin/hey-jarvis` as the LaunchAgent `com.arnav.hey-jarvis`.

References below are to `~/jarvis-wake/hey_jarvis.py` as `H:line` unless another file is named. The code was not a git repository and had no README, so the reasons behind some choices are inferred from comments and the log (`~/jarvis-wake/jarvis.log`).

## 1. Wake word

| | |
|---|---|
| Engine | openWakeWord 0.6.0, `Model(wakeword_models=["hey_jarvis"], inference_framework="onnx")` (H:1185) |
| Model | `hey_jarvis_v0.1.onnx`, shipped inside the openwakeword package |
| Threshold | 0.4 (H:1158) |
| Frames | 1,280 samples (80 ms) at 16 kHz (H:45-46) |
| Confirmation | none; after a conversation it only reset the detector and flushed the mic (H:1104-1105) |

**What worked.** Detection ran continuously on little CPU, and saying the wake word always interrupted speech (H:898).

**What did not.**
- The log shows 31 real triggers, which scored only about 0.42, and 58 "almost heard" near misses (scores of 0.15 or more, H:1092-1094). The threshold sat right at the edge: misses were common, and there was no second check to allow a lower threshold safely.
- The model needs "hey"; the single word "Jarvis" was never supported.
- Whisper often writes "Jarvis" as "travis" or "jervis", and once "service". The code absorbed these in `CALL_WORDS` (H:116).

**For Scribe.** Use a single-word model and measure it; add a second-stage confirmation with Whisper so the first stage can be sensitive; accept the known mishearings when reading "Jarvis" from a transcript.

## 2. Microphone capture

- `sounddevice.InputStream` at 16 kHz mono, 16-bit, 10 ms blocks (H:361-364), joined into 80 ms frames on a queue (H:356-359). No resampling on the mic side.
- **Stalls.** If no frame arrived for 5 s it raised `AudioStalled` and exited so launchd restarted it (H:376-381, H:1218-1220). The log shows 11 such stalls, from sleep and wake.
- **Device changes.** PortAudio only notices new devices at startup, so a thread checked the default devices every 15 s in a fresh subprocess and exited when they changed (H:1108-1131). The log shows 13 restarts for AirPods switching.
- **While muted** the callback still ran echo cancellation, to stay in sync, but dropped the audio (H:352-355).

**For Scribe.** The browser handles device changes and sleep for us (`getUserMedia`), which removes this whole class of restart logic. Keep the idea of continuing to feed the canceller while muted.

## 3. Voice activity and turn-taking

- **Energy only (RMS), no model.** A noise floor that falls fast and rises slowly, capped at 1,500 (H:1085-1089); speech is anything above `max(300, 3 × noise)` (H:745-746).
- **End of turn:** 0.6 s of quiet (H:1162, H:823), with about 0.3 s of lead-in kept (H:805). Maximum utterance 45 s (H:1163).
- **Right after the wake word:** skip 3 frames, look at 7 (about 0.55 s); if 2 or more are loud, treat it as the start of the request, otherwise say "Yes?" (H:771-788).
- **Follow-ups without the wake word (H:969-1054):** 8 s for the first line, 6 s for each follow-up, 12 s when a question is pending, 6 s after an interruption. Noises without words count the wait down rather than resetting it (H:1026). Talked over twice before saying a word, it assumes you are speaking to someone else and stops (H:1036-1041). A false start is merged with what follows (H:1042-1047).

**For Scribe.** Scribe's chunker already uses the same adaptive energy idea with a 0.9 s end-of-speech pause. Reuse the follow-up window, the "noises count down" rule, and the false-start merge for the spoken counselor.

## 4. Speech to text

- `POST /v1/speech/transcribe` on the OpenJarvis server, 16-bit WAV, `language=en` (H:521-529). Model: faster-whisper `base` (the default in `~/.openjarvis/src/src/openjarvis/core/config.py:1625`). No vocabulary hint was sent.
- Common slips were repaired by a regex table after transcription (`actions.py:134-139`).

**For Scribe.** Scribe uses a much stronger model (large-v3-turbo) and already sends a vocabulary hint; add "Jarvis" to that hint.

## 5. Text to speech

- **Engine and voice:** Kokoro-82M through `POST /v1/speech/synthesize` (H:531-541), voice `bm_george`, speed 1.0 (`settings.json`).
- **Sample rate:** Kokoro produces 24 kHz; it was upsampled to 48 kHz with `scipy.resample_poly` because plain linear resampling "sounds dull and gritty" (H:178-186).
- **Chunking:** sentence by sentence; the first chunk may end at a comma, but only in a long sentence, because short splits sound choppy (H:95-97, H:117).
- **Polish per chunk (H:189-206):** trim silence, 8 ms fades at both ends, a soft gain, and a 0.22 s pause after a sentence or 0.07 s after a clause.
- **Text clean-up before speaking (H:155-175):** links, emails, "e.g." and all-caps words are rewritten; caps words were otherwise spelled out letter by letter (H:172).
- **Quirk:** a single word sounds clipped from Kokoro, so the "Yes?" acknowledgement was cut out of a longer sentence and cached (H:209-260).
- **Playback:** one gapless output stream at 48 kHz; interruption by a volume ramp, pause and reset (H:413-482). `spoken()` worked out which words were actually heard, so an interrupted reply was saved honestly (H:460-473).

**For Scribe.** Keep Kokoro, sentence-by-sentence synthesis, the fades and pauses, the text clean-up, and the cached acknowledgement. Record only what was actually spoken when interrupted.

## 6. Language model

- Ollama `/api/chat`, `qwen3.5:4b`, `stream: true`, `think: false`, `keep_alive: "30m"` (H:611-612, H:1153). The OpenJarvis chat endpoint did not truly stream, so Ollama was called directly.
- The system prompt was kept byte-identical every turn so Ollama could reuse its cache (H:606-610). Context was the last 8 messages, cleared after 15 minutes idle (H:566-567, H:610). A reply cut off by the user was saved with `[interrupted]` (H:570-574).
- Simple commands were routed by regular expressions and skipped the model (`actions.quick`, H:593-605).
- If the model claimed it had done something without calling a tool, the assistant said "I haven't actually done that" (H:640-655).

**For Scribe.** Same pattern: rules first, model second, and never trust the model's claim that something was done. Scribe goes further, since its model can never edit the essay at all.

## 7. Latency

Measured in `tests/bench-after.json` (totals, speech end to audio):

| Kind of request | Time |
|---|---|
| Commands routed without the model | 600-865 ms |
| Questions answered by the model | 1,664-1,897 ms (speech-to-text about 400, first sentence from the model about 450, voice about 600) |
| Before tuning | up to 4,717 ms |
| In real use, from the log | 1,004-4,707 ms |

What bought that:
- **Warm-up** at start: an empty chat with `keep_alive`, and synthesizing "Ready." (H:505-512).
- **Pre-rendered phrases:** 20 common replies synthesized in the background, and a cache of up to 200 short phrases (H:543-563).
- **Early transcription:** speech-to-text starts after only 0.16 s of quiet, in parallel, and is thrown away if speech resumes (H:814-822).
- **Streaming:** the reply is split into sentences and each is synthesized while the next is still being written (H:855-874).

**For Scribe.** All four apply directly and are in the plan. The real-use spread (up to 4.7 s) is a warning that the 2.5 s target must be measured under load, not assumed.

## 8. Hearing its own voice, and barge-in

- **Echo cancellation:** livekit 1.2.1 `AudioProcessingModule(echo_cancellation=True, noise_suppression=True, high_pass_filter=True)` (H:293-294). Every speaker block was fed to it as the reference at 48 kHz, the mic was cleaned in 10 ms frames at 16 kHz (H:299-317), and the delay was set to output plus input latency (H:1200).
- **The canceller is not enough on its own.** A comment notes it lets some of the assistant's voice through at onset (H:903-904). So barge-in was gated: not within about 1.2 s of speech starting from silence (H:905-906), three loud frames in a row above `max(speech level, 0.35 × the user's usual peak)`, then the volume dipped to 0.3 for five more frames, and it counted as real only if two of those were loud or the burst was strong (H:910-936). The user's own loudness was learned over time (H:996-999).
- **Backstops:** the wake word always interrupts (H:898); the mic is muted during beeps (H:751-757) and flushed after the acknowledgement and after replies (H:769, H:963-965).
- **Evidence of trouble:** early in the log there are many `[interrupted before speaking]` lines, which suggests the assistant was interrupting itself before these gates were tuned. There is no build history, so this is inferred.
- A lone word spoken over the assistant was often garbled, so its text was not trusted (H:1016-1017).

**For Scribe.** Play the voice inside the page so the browser's own echo cancellation has the reference signal; keep an onset guard and a several-frames rule; dip the volume before deciding; and add a text filter that drops any transcript matching what was just spoken, which Jarvis did not have.

## 9. Bugs and gotchas hit

| Problem | Evidence | Lesson |
|---|---|---|
| Microphone-permission crash loop | "microphone is silent" appears **2,944 times** in the log. Under launchd, macOS had not granted mic access, so the process exited and restarted every 20 s (H:1206-1211) | A background service with no window cannot ask for the microphone. Scribe asks from a visible page, and shows a clear message when access is refused |
| Mic stalls after sleep | 11 times | Left to the browser |
| Restarts on AirPods switching | 13 times | Left to the browser |
| `faiss-cpu` crashed with torch and Kokoro in the OpenJarvis environment | project notes | Keep the speech stack small and separate from other machine-learning packages |
| Kokoro needed a spaCy model installed separately | project notes | Use a Kokoro build with no Python dependencies |
| `jarvis gui` rejected Node 25 | project notes | Scribe is already tested on Node 25 |
| Heavy memory use on 16 GB with a 4B model plus the OpenJarvis server | project notes | Measure memory with everything loaded; do not leave a second model loaded |
| "Fully local" was not quite true: `gcal.py:22` called googleapis.com | code | Scribe enforces local-only with a content policy and tests that block the network |
| Failures swallowed silently in warm-up and pre-rendering (H:510, H:561) | code | Report failures in the interface |

No error lines or tracebacks appear anywhere in the log.

## 10. Sounds

Sine chimes made in code: 120 ms, Hanning window, amplitude 0.25 (H:142-144); 880 Hz for "go ahead" and 587 Hz for "going to sleep" (H:1075). The spoken "Yes?" was cached as `voice-samples/ack.wav`.

**For Scribe.** Generate earcons in code the same way; no sound files.

## 11. Testing without a human voice (worth reusing)

- `tests/mkinject*.py` synthesized scripted lines with Kokoro in a *different* voice from the assistant's (`am_michael`), normalized the level, and placed them at set times in a 16 kHz recording. `mkinject4` added a quiet second speaker to test background chatter.
- `--inject-wav` mixed that recording into the real microphone callback *before* echo cancellation (H:348-351), so barge-in and echo handling were tested against the real speakers with nobody in the room.
- `tests/live.py` ran the real listener with that recording for a set time and printed the log. `tests/bench.py` timed each stage. `tests/test_router.py` checked command routing using phrases taken from the log.

**For Scribe.** Scribe's live tests already play recordings in as the microphone. Add scripted multi-turn recordings with timed interruptions, and a quiet second speaker, for the counselor and barge-in tests.
