"""Measure two lightweight keyword spotters on the wake-word recordings.

Run from the scribe folder:
  uv run --with sherpa-onnx --with sentencepiece --with vosk --with numpy python app/scripts/wake-eval/spotters.py

Models are downloaded once into .tools/wake-eval/models/ (about 60 MB).
The recordings come from make-audio.mjs.
"""
import glob
import json
import os
import sys
import tarfile
import urllib.request
import wave
import zipfile

import numpy as np

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", ".."))
EVAL = os.path.join(ROOT, ".tools", "wake-eval")
MODELS = os.path.join(EVAL, "models")
os.makedirs(MODELS, exist_ok=True)


def read(path):
    with wave.open(path, "rb") as w:
        assert w.getframerate() == 16000 and w.getnchannels() == 1
        return np.frombuffer(w.readframes(w.getnframes()), dtype=np.int16)


def files(folder):
    return sorted(glob.glob(os.path.join(EVAL, folder, "*.wav")))


def fetch(url, name):
    dest = os.path.join(MODELS, name)
    if not os.path.exists(dest):
        print(f"downloading {name} ...", flush=True)
        urllib.request.urlretrieve(url, dest)
    return dest


def report(label, count_in):
    """count_in(samples) -> number of detections in that recording."""
    pos = files("positive")
    hit = {"alone": [0, 0], "hey": [0, 0], "request": [0, 0]}
    for f in pos:
        kind = os.path.basename(f).split("-")[0]
        hit[kind][1] += 1
        if count_in(read(f)) > 0:
            hit[kind][0] += 1
    woke = sum(h[0] for h in hit.values())
    content = sum(1 for f in files("content") if count_in(read(f)) > 0)
    false, seconds = 0, 0.0
    for f in files("negative"):
        s = read(f)
        seconds += len(s) / 16000
        false += count_in(s)
    print(
        f"{label}: calls {woke}/{len(pos)} "
        f"(alone {hit['alone'][0]}/{hit['alone'][1]}, hey {hit['hey'][0]}/{hit['hey'][1]}, request {hit['request'][0]}/{hit['request'][1]}); "
        f"fired on {content}/{len(files('content'))} in-sentence uses; "
        f"dictation false wakes {false} in {seconds / 60:.1f} min = {false / seconds * 600:.2f} per 10 min",
        flush=True,
    )


def sherpa():
    import sherpa_onnx

    name = "sherpa-onnx-kws-zipformer-gigaspeech-3.3M-2024-01-01"
    folder = os.path.join(MODELS, name)
    if not os.path.isdir(folder):
        archive = fetch(f"https://github.com/k2-fsa/sherpa-onnx/releases/download/kws-models/{name}.tar.bz2", name + ".tar.bz2")
        with tarfile.open(archive) as t:
            t.extractall(MODELS)
    pick = lambda pattern: sorted(glob.glob(os.path.join(folder, pattern)))[0]
    tokens = os.path.join(folder, "tokens.txt")
    pieces = sherpa_onnx.text2token(["JARVIS"], tokens=tokens, tokens_type="bpe", bpe_model=os.path.join(folder, "bpe.model"))[0]
    print("sherpa-onnx keyword pieces:", " ".join(pieces), flush=True)
    for threshold in (0.1, 0.25, 0.4):
        keywords = os.path.join(MODELS, "jarvis-keywords.txt")
        with open(keywords, "w") as f:
            f.write(" ".join(pieces) + f" :1.5 #{threshold} @JARVIS\n")
        spotter = sherpa_onnx.KeywordSpotter(
            tokens=tokens,
            encoder=pick("encoder-epoch-12-avg-2-chunk-16-left-64.onnx"),
            decoder=pick("decoder-epoch-12-avg-2-chunk-16-left-64.onnx"),
            joiner=pick("joiner-epoch-12-avg-2-chunk-16-left-64.onnx"),
            keywords_file=keywords,
            num_threads=2,
            provider="cpu",
        )

        def count_in(samples):
            stream = spotter.create_stream()
            n = 0
            audio = samples.astype(np.float32) / 32768
            for i in range(0, len(audio), 1600):
                stream.accept_waveform(16000, audio[i : i + 1600])
                while spotter.is_ready(stream):
                    spotter.decode_stream(stream)
                    if spotter.get_result(stream):
                        n += 1
                        spotter.reset_stream(stream)
            return n

        report(f"SHERPA-ONNX KWS threshold {threshold}", count_in)


def vosk():
    import vosk as v

    v.SetLogLevel(-1)
    name = "vosk-model-small-en-us-0.15"
    folder = os.path.join(MODELS, name)
    if not os.path.isdir(folder):
        archive = fetch(f"https://alphacephei.com/vosk/models/{name}.zip", name + ".zip")
        with zipfile.ZipFile(archive) as z:
            z.extractall(MODELS)
    model = v.Model(folder)
    in_vocab = model.vosk_model_find_word("jarvis") >= 0 if hasattr(model, "vosk_model_find_word") else None
    print("vosk: 'jarvis' in vocabulary:", in_vocab, flush=True)

    def count_in(samples):
        rec = v.KaldiRecognizer(model, 16000, '["jarvis", "hey jarvis", "[unk]"]')
        n = 0
        data = samples.tobytes()
        for i in range(0, len(data), 8000):
            if rec.AcceptWaveform(data[i : i + 8000]):
                n += json.loads(rec.Result()).get("text", "").split().count("jarvis")
        n += json.loads(rec.FinalResult()).get("text", "").split().count("jarvis")
        return n

    report("VOSK restricted grammar", count_in)


for name, run in (("sherpa-onnx", sherpa), ("vosk", vosk)):
    try:
        run()
    except Exception as err:  # report and carry on with the other candidate
        print(f"{name.upper()} could not be evaluated: {type(err).__name__}: {err}", flush=True)
sys.exit(0)
