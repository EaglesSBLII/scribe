# Scribe

A free, local, voice-first essay writing app. You talk; Scribe writes down what you said, removes the "um"s, adds punctuation and follows spoken commands. It never writes for you: the only things it adds are punctuation, capitals and paragraph breaks.

Everything runs on your Mac. Speech-to-text is [whisper.cpp](https://github.com/ggml-org/whisper.cpp); advice comes from a local model through [Ollama](https://ollama.com); the voice is [Kokoro](https://github.com/hexgrad/kokoro), run with [sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx). There are no accounts on a server, no API keys and no usage limits.

Say **“Jarvis”** to wake it, talk to the counselor out loud and hear it answer, and use it from your iPhone with the Mac as the brain ([docs/phone-setup.md](docs/phone-setup.md)).

**Build status:** all nine build phases are done: accounts, essays, editor, autosave, undo, version history, dictation, voice edit commands, word counts, counselor, the four-stage process, export, college database, grading, personal memory, math and physics mode, and formatting learned from sample papers.

## Download for Mac

Get **Scribe-0.3.0-arm64.dmg** from the [latest release](https://github.com/EaglesSBLII/scribe/releases/latest). It is for Apple Silicon Macs (M1 or newer) and was built on macOS 26; it has not been tried on older versions of macOS.

1. Open the .dmg and drag **Scribe** into **Applications**.
2. Scribe is not signed with an Apple developer certificate, so macOS blocks it the first time. Open Terminal and run:

   ```bash
   xattr -cr /Applications/Scribe.app
   ```

   Then open Scribe normally. (Or try to open it, then go to System Settings → Privacy & Security and press **Open Anyway**.)
3. Dictation and the voice work straight away: the speech and voice models are inside the app.
4. For the counselor and grading, install [Ollama](https://ollama.com/download), then run:

   ```bash
   ollama pull qwen3.5:9b
   ```

   Any other model you have in Ollama can be chosen in the counselor panel.

Everything you write stays on your Mac. The one thing the Mac app ever contacts is GitHub's release page, to see whether a newer Scribe exists; nothing you write is sent. See [docs/updates.md](docs/updates.md).

### Updating

From 0.3.0 the Mac app updates itself, the way Chilaka does: a small banner says a new version is available, **Update** downloads it with a progress bar, and **Restart** swaps it in. Settings has "Check for updates" and a switch for downloading automatically. Versions before 0.3.0 have no updater, so the first 0.3.0 install is by hand.

## Setup from source

One command checks and installs everything, builds the app and starts it:

```bash
./setup.sh
```

It will:

1. check Node (20 or newer),
2. install the JavaScript packages,
3. build `whisper-server` from source (installing a private copy of cmake in `.tools/` if you have none) and download the speech model (about 575 MB),
4. download the Kokoro voice (about 305 MB),
5. check Ollama is installed and running, and download the counselor model if it is missing,
6. build Scribe and open it at http://127.0.0.1:4310.

Options: `./setup.sh --no-run` sets up without starting; `./setup.sh --desktop` starts the Mac app instead of the browser version.

You need to install two things yourself first: [Node](https://nodejs.org) and [Ollama](https://ollama.com/download). The Xcode Command Line Tools are needed to compile Whisper (`xcode-select --install`).

Setup is the only time the network is used. After that Scribe refuses to connect to anything but this machine.

### Choosing models

| Setting | Default | Change with |
|---|---|---|
| Speech model | `ggml-large-v3-turbo-q5_0.bin` | `SCRIBE_WHISPER_MODEL=ggml-small.en.bin ./setup.sh` |
| Counselor model | `qwen3.5:9b` | `SCRIBE_LLM=llama3.1:8b ./setup.sh` |

## Running it

| Command | What it does |
|---|---|
| `npm start` | Web app at http://127.0.0.1:4310, with dictation |
| `npm run desktop` | Mac app (development mode) |
| `npm run dist:mac` | Builds `desktop/dist-electron/Scribe-<version>-arm64.dmg` |
| `npm run dev` | Web app with live reload; run `npm start` alongside it for dictation |

The browser version and the Mac app each keep their own copy of your essays (as Chilaka does). Each also keeps a master copy for syncing with a phone: `data/` in this folder for `npm start`, the app's own data folder for the Mac app.

## Hardware

- Apple Silicon Mac (built and tested on an M5 with 16 GB of memory).
- About 9.5 GB of free disk: 0.6 GB for the speech model, 0.4 GB for the voice, 7.6 GB for the default counselor model.
- 16 GB of memory is recommended to run the speech model and a 9B counselor model together. With 8 GB, use `ggml-small.en.bin` and a smaller Ollama model.
- A microphone.

On the M5, a 7-second recording is transcribed in about one second.

## Dictating

Press **Dictate** and talk. Rough grey text appears while you speak; when you pause for about a second, the cleaned sentence is added to the essay. Text goes to the end of the paragraph you last clicked in, or the last paragraph.

What Scribe cleans up:

- **Fillers:** um, uh, er, hmm. "Like" and "you know" are removed only when they are clearly fillers ("it was, like, cold"); "I like boats" is kept.
- **Repeats and false starts:** "the the dock", "I was I was going", "b-b-boat".
- **Capitals and sentence ends:** sentence starts and "I" are capitalised, and a period closes what you said when you pause.

### Voice commands for punctuation

| Say | You get |
|---|---|
| "period" or "full stop" | `.` |
| "comma" | `,` |
| "semicolon" | `;` |
| "colon" | `:` |
| "question mark" | `?` |
| "exclamation point" or "exclamation mark" | `!` |
| "dash" | ` — ` |
| "quote" ... "end quote" (or "unquote") | `“ ... ”` |
| "new paragraph" or "new line" | starts a new paragraph |

Scribe decides from context whether you meant the command or the word. "The Jurassic period was huge" keeps the word; "I love boats period" ends the sentence. When it is not sure, the word or mark gets a yellow highlight: click it once to switch to the other reading.

### Voice commands for editing

Say a command as its own sentence, in one breath, with a pause before and after. Scribe shows what it understood ("Inserting after P3·S1") for about a second, with a Cancel button, then does it and offers Undo. Anything that does not fit the command grammar is treated as dictation.

Paragraphs and sentences are numbered from 1; the editor shows P1, P2 and so on. You can say "paragraph 3", "the third paragraph", "the last paragraph" or "this paragraph", and "sentence 2", "the second sentence" or "the last sentence". If you name no paragraph, Scribe uses the one you are dictating into.

| Say | What happens |
|---|---|
| "Insert *your words* between sentences 1 and 2 in paragraph 3" | Your words go exactly there. Also: "after sentence 1", "before sentence 2", "at the start", "at the end". "Add" and "put" work too. |
| "Delete the last sentence" / "delete sentence 2 in paragraph 3" | Removes one sentence. |
| "Delete sentences 1 through 3 in paragraph 2" / "delete paragraph 4" | Asks for confirmation first, showing the text. |
| "Move paragraph 4 above paragraph 2" | Also "below", "to the top", "to the end", "up", "down". |
| "Replace happy with relieved in paragraph 1" | Whole words only. Without a paragraph it applies to the whole essay. "Change ... to ..." works too. |
| "Undo" / "scratch that" / "redo" | Steps back or forward one change. |
| "Read back paragraph 2" / "read the last sentence" / "read everything" | Reads your text aloud with the Mac's voice. |
| "Word count" / "how many words" | Shows and speaks the count. |
| "How many words in paragraph 3" | Count for one paragraph. |
| "How many words left for this prompt" | Words left under the limit typed next to the word count. |

Word counts are computed in code, never by a model: anything between spaces that contains a letter or digit is one word, the way word processors count. A dash standing on its own is not counted.

If you phrase an edit request another way ("take out the second sentence"), Scribe asks the local model to restate it in the grammar above, checks that restatement in code, and then shows it like any other command. The model never supplies the words that go into the essay.

## Hands-free: the wake word

Switch on **Jarvis** in the toolbar (or in Settings). The microphone stays open and Scribe waits; nothing said before the name is kept or written down.

- **“Jarvis”** on its own wakes it: a short sound, “I'm listening”, and dictation starts. “Hey Jarvis” works too but is not needed.
- **“Jarvis, …”** while dictating is a command or a question, never essay text: “Jarvis, delete the last sentence”, “Jarvis, what do you think of my opening?”.
- The name inside a sentence stays text: “My friend called me Jarvis.”
- “Jarvis, stop listening” (or “go to sleep”, “that's all”) goes back to waiting.

The wake word is read from Whisper's own transcript rather than by a separate always-on detector. That was chosen by measurement: on 60 synthetic recordings of the name it woke 60 times, with no false wakes in 13.7 minutes of dictation full of near-words (“Travis”, “service”, “jarring”). It has been tested with synthetic voices only; your own voice may differ.

More things you can say:

| Say | What happens |
|---|---|
| “Delete what I just said” / “scratch that” | Removes exactly your last utterance. |
| “Delete the last five words” / “delete the last word” | Removes exactly that many. |
| “Go back to the sentence about the engine” | Scribe finds it, reads it back and asks “this one?”. New words then go after it. |
| “Coach mode” / “draft mode” / “conversation mode” | Changes how much the counselor speaks up. |

Casual phrasing works too. "Scratch that", "strike that", "nix that", "get rid of that" and "take that back" all remove what you just said; "get rid of", "take out", "kill", "nuke", "ditch" and "drop" all mean delete ("take out the last sentence", "nuke paragraph two"); and filler around a request is ignored ("okay, can you just delete the last three words for me"). Looser phrases such as "oops", "my bad", "forget that", "go back", "how long is my essay", "am I over the limit", "what did I just say", "be quiet" and "let's talk" count only when said to Jarvis by name, because on their own they could be part of your essay.

Measured on 232 recorded requests (58 phrasings, four synthetic voices), the fixed rules alone understood all 232 (100%), and none of 40 ordinary sentences using the same words was taken as a command. Requests the rules miss go to the local model, which is not counted in that figure.

Scribe never guesses at a deletion. If a request is unclear it asks out loud; if it would remove more than a sentence it reads back what will go and waits for “yes, delete it”. Every applied command plays a short sound, shows a chip with one-tap Undo, and can be undone by saying “undo”.

## Math and physics mode

Press **Math** next to Dictate to switch it on for an essay. Spoken mathematics is then written as mathematics and drawn with KaTeX. It only writes down what you say: it never simplifies, evaluates or solves. The conversion is done by fixed rules, with no model involved.

| Say | You get |
|---|---|
| "x squared over two" | x²/2 |
| "integral from zero to pi of sine x d x" | ∫ from 0 to π of sin x dx |
| "one half m v squared" | ½mv² |
| "the quantity a plus b over c" | (a + b) over c, as a stacked fraction |
| "d y d x equals two x" | dy/dx = 2x |
| "sum from i equals one to n of i squared" | Σ from i = 1 to n of i² |
| "x double dot equals negative omega squared x" | ẍ = −ω²x |
| "nine point eight meters per second squared" | 9.8 m/s² |
| "vector F equals m vector a", "delta x over delta t", "h bar omega" | vectors, Δ, ℏ and the Greek letters |

How an utterance is treated in math mode:

- **Entirely mathematics** ("x squared over two"): added to the current paragraph as a formula.
- **"Equation ..."**: a numbered equation on its own line.
- **"... math one half m v squared end math ..."**: a formula inside a sentence.
- **"Heading ..."**, **"subheading ..."**, **"caption ..."**: a section heading, a subsection heading, or a figure caption.
- **Anything else**: ordinary dictation, exactly as outside math mode.

Click a formula, heading or caption to edit its text. Formulas are stored as LaTeX between dollar signs (doubled for a numbered equation); a heading is a paragraph starting with `# ` (or `## `), and a caption one starting with `Figure: `. You can type these directly. A formula counts as one word.

### Formatting like a sample paper

In the Finish stage, **Learn from a sample** takes a PDF or Word (.docx) paper and reads its formatting: page size and margins, body font and size, line spacing, how headings are numbered (none, 1. 2., or I. II.), how equations are numbered ((1) or (2.1)), and how figure captions are labelled ("Figure 1:" or "FIG. 1."). It lists what it found and what it could not find. Only the formatting is kept; none of the sample's text is stored, and the file is read on this Mac.

Choose the learned format in the **Format** list and export:

- **.pdf** opens the print window with typeset mathematics, numbered equations, headings and captions in that format. Choose "Save as PDF".
- **.docx** uses the format's fonts, sizes, spacing, margins and numbering. Equations are written on one line in ordinary characters (for example ∫₀^(π) sin x dx), not as Word equation objects.
- **.txt** uses the numbering and labels.

Your words are never changed by a format; it adds only numbers, labels and layout. An ordinary essay with no mathematics and no chosen format exports exactly as before.

## The four stages

Each essay has a stepper: **Brainstorm → Draft → Refine → Finish**. You can open any stage at any time, and a version is saved whenever you change stage.

- **Brainstorm:** the counselor asks one question at a time and you answer by typing or by voice. Your answers stay in the panel, not the essay. "Map my stories" lists the stories you told, each anchored in your own words and rated 1-5 for how well it fits the prompt.
- **Draft:** the panel closes and nothing interrupts you. Just dictate.
- **Refine:** ask the counselor for feedback and edit by voice.
- **Finish:** "Run final checks" reports the word limit, whether the essay answers the prompt, mechanical slips and possible typos. Everything is flagged for you; nothing is fixed automatically. Then export to .docx, .pdf or .txt.

## The counselor

Open it with the speech-bubble button. Ask by typing, or press the microphone in the panel and speak one question.

- It gives advice only: what to add, cut or clarify, and why. It quotes your lines back with their location, such as (P1·S2). Quotes of your own words are tinted green; any example wording of its own is shown in grey italics.
- It will not write or rewrite essay text. If you ask it to, it declines and offers questions or an outline. If the model drafts text anyway, Scribe detects it, asks once more, and otherwise shows a refusal.
- Nothing it says can reach the essay. The counselor code has no access to the part of the app that edits essays, and the panel has no "insert" button.
- Choose a college and prompt above the essay (or paste a prompt into the panel) so it can judge whether you answered it.
- Change the model with the picker at the top of the panel. It lists whatever Ollama has downloaded on this Mac.

The counselor's feedback comes from a small local model. Treat it as a second reader, not an authority.

### Talking with it

Ask by voice (“Jarvis, is the ending clear?”) and it answers out loud, in a few sentences, usually ending with a question back to you. Typed questions are answered in the panel only.

- **Interrupt it by talking.** It stops within about a fifth of a second and listens. Its own voice is filtered out of what the microphone hears, so it never ends up in your essay. On loud speakers, headphones work best; the setting “Let me interrupt by talking” can be switched off.
- **Three modes** (Settings, or by voice). *Draft*: quiet; only commands and questions you ask by name. *Coach*: also speaks up briefly when a paragraph ends, when you pause for about six seconds, or near the word limit. *Conversation*: a full back-and-forth where what you say goes to the counselor, not into the essay; this is the default while brainstorming.
- **Voice and models** are chosen in Settings. The voice has eleven speakers. Spoken edit requests are read by the counselor's model by default, so only one model is in memory; a smaller, faster one can be chosen.
- Whatever it says, it still cannot write in your essay.

### Sounds

Eight short cues are made by Scribe itself (no sound files): wake word heard, listening started, listening stopped, command applied, needs confirmation, command failed, saved (at most once a minute) and counselor about to speak. Settings has one volume and a switch for each.

## On your iPhone

The same app runs in Safari on an iPhone and can be added to the Home Screen. The Mac does the work; the phone keeps its own copy of your essays and syncs through the Mac. It needs a private connection between the two and a password you set on the Mac. Setup, what syncs, and what iOS does not allow are in [docs/phone-setup.md](docs/phone-setup.md).

- Away from the Mac you can still dictate: recordings are kept on the phone and transcribed when it is reachable again.
- The server is never opened to the internet, and another device gets nothing until it has signed in.

## My voice and memory

Scribe learns how you write so that feedback keeps your essays sounding like you. Open **My voice and memory** at the bottom of the sidebar to see all of it. It is tied to your account and stored only on this Mac.

| What | Where it comes from |
|---|---|
| Sentence rhythm (average length, share of short and long sentences) | Counted in code from your essays and from what you say while brainstorming |
| Words you use often | Counted in code; a word appears after three uses. Remove any that are not yours, or add your own |
| How you write (tone notes) | Written by the local model when you press "Describe my voice from my essays". A note is kept only if it rests on a line that is word for word yours |
| Stories you have already used | Same button; one per essay, so the counselor can warn you when a new essay repeats a story |
| Feedback you accepted or rejected | The "Useful" and "Not for me" buttons under each counselor reply. Rejected advice is not offered again |

How it is used:

- **Voice check** (in Refine and Finish) lists lines that sound less like you, measured in code: a sentence far longer than your usual, or stock essay words such as "plethora" that you use nowhere else. It also shows one of your own lines that does sound like you.
- **The counselor** is given your profile and told to strengthen your voice: to say when a line is unlike you, to point to a line of yours that is, and never to push you toward a more formal or generic style.

Everything can be edited or deleted item by item. **Learn from my writing** switches memory off: nothing is learned and nothing remembered is used. **Delete all memory** removes every note. Rhythm and vocabulary are recounted from your essays each time rather than stored, so they follow your writing as it changes.

## Grading

In Refine or Finish, open **Grade** in the counselor panel and press **Grade this draft**. You get a score out of 100, labelled **"Rubric-based estimate, not an admissions decision."**

- **Six sections**, each scored on its own: Answers the prompt, Authenticity and voice, Specificity and detail, Structure and flow, Insight and reflection, Mechanics.
- **A written rubric.** Every section has a description for each of five bands. The model picks a level from 1 to 10 against those descriptions and must quote one line of your essay to justify it. Scribe checks that the quote really is in your essay; if the model cannot give one, the card says so.
- **The total is arithmetic.** Each level is multiplied by its weight and added up in code.
- **Weights.** Defaults are 25 / 20 / 20 / 10 / 15 / 10. You can set your own per college in **Colleges and prompts**. These are Scribe's settings, not any school's scoring. Short answers (200 words or fewer) put less weight on structure, and "Answers the prompt" is left out when no prompt is set.
- **Score history.** Each graded draft is kept, with a small chart, so you can see the score move across drafts and reopen an earlier breakdown.

**Same text, same score.** Two things make this hold:

1. A grade is stored with a fingerprint of the text, prompt, weights, model and rubric. Grading the same draft again returns the stored grade.
2. A fresh grading is made repeatable too: temperature 0, a fixed seed, one request per section, and the model is unloaded first so every run starts from the same state. (Ollama reuses work from earlier requests, and how much it reuses was found to change answers.) This adds a few seconds; a grade takes about 20 seconds on an M5.

To check repeatability on your own machine: `node app/scripts/determinism-check.mjs`.

Treat the number as a rough, repeatable yardstick for comparing your own drafts. It comes from a small local model, tends to mark low, and is not a prediction of any admission result.

## Colleges and prompts

Scribe keeps a local, editable database of colleges, their essay prompts and word limits, what each school says it wants, and any review criteria the school has published. Pick a **College** and **Prompt** above the essay: that fills in the prompt, the word limit and the essay's title, and tells the counselor what the school has published.

The starter data was read from official admissions pages on 22 November 2026 for the 2026-27 cycle:

| Entry | Stored |
|---|---|
| Common App | 7 personal essay prompts (250-650 words) |
| University of California | 8 Personal Insight Questions (350 words, answer 4), 13 comprehensive review factors |
| The 9 UC campuses | each uses the UC questions, plus a short note of what that campus says it looks for |
| Penn | 16 prompts (2 for everyone, 4 school-specific, 10 for dual-degree programs), review questions |
| Columbia | 6 Columbia-specific questions, what Columbia looks for |
| UChicago | "Why UChicago" and 6 extended essay options (no word limits published) |
| University of Washington | uses the Common App essay, plus the optional Additional Information question; holistic review factors |
| Penn State | linked to the Common App prompts (it accepts that essay as its optional personal statement); evaluation factors |
| UIUC | **nothing stored**: its admissions site could not be read automatically |

Every entry shows its source address and cycle year. Anything not confirmed on an official page is marked **unverified**: currently UIUC, UC Merced, UC Davis and UC Santa Cruz (the campus notes only; their questions are the verified UC ones). Scribe never fills in criteria a school has not published. "What great essays do" holds 26 short principles paraphrased from published admissions guidance, each with its source; no sample essays are stored.

**Updating each cycle:** open **Colleges and prompts** at the bottom of the sidebar. You can add a school, add or edit prompts, change limits, source addresses and cycle years, and tick "Verified" once you have checked the official page. Your edits are kept even when a newer starter set is installed. Prompts and deadlines change every year: check the school's own site before you submit.

To rebuild the starter set from the research files: `node app/scripts/build-seed.mjs`.

### Almost every US college by name

The college box is a search field over 1,963 four-year US colleges from the federal IPEDS directory (2023): name, city, state and official website. Only the 17 researched schools have prompts stored. For every other school Scribe says so plainly and links the school's own site; you paste this year's prompt yourself. Scribe never invents a prompt or what a school "wants".

## Safety rules the app enforces

- Removing more than one sentence, a paragraph or an essay always shows a dialog listing exactly what will go.
- Every edit can be undone; the undo history has no limit and survives restarts.
- Every change is saved within half a second. There is no unsaved state.
- A version of each essay is kept every 10 minutes of writing, before any large deletion, and whenever you press Save a version.

## Tests

```bash
npm test            # unit tests: document model, deletion guard, cleanup rules, chunker
npm run build && npm run e2e   # browser tests against the built app
npm run e2e:live    # real Whisper and real Ollama: recordings are played in as the microphone
npm run smoke       # launches the Mac app: transcribes, speaks and syncs through it
npm run e2e:phone   # a "Mac" and a phone-sized browser: sign-in, sync both ways, offline recording
npm run eval -w app       # wake-word measurements
npm run e2e:long -w app   # a ten-minute spoken conversation; the essay must come out unchanged
```

## What Scribe is built on

All free and open source. Runtime: React, Zustand, Dexie (IndexedDB), KaTeX, docx, pdf-lib, pdf.js, JSZip, lucide-react. Tools: Vite, TypeScript, Tailwind, Vitest, Playwright, Electron, electron-builder. On your Mac: whisper.cpp (built by `setup.sh`), Ollama, and the Kokoro voice run by sherpa-onnx (`sherpa-onnx-node` 1.13.8, Apache-2.0).

## Layout

```
app/       the web app (React, TypeScript, Vite, Dexie over IndexedDB)
local/     local services: runs whisper-server and the voice, serves the app, signs in and syncs a phone
docs/      phone setup; lessons kept from the earlier Jarvis assistant
desktop/   the Mac shell (Electron); loads the same bundle as the web app
setup.sh   one-command setup
```
