#!/bin/bash
# Scribe: one-command setup and run.
#   ./setup.sh            check/install everything, build, then start the web app
#   ./setup.sh --no-run   set up only
#   ./setup.sh --desktop  set up, then start the desktop app instead
#
# The network is used here only (packages, Whisper source, models).
# Once set up, Scribe itself never leaves this machine.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
TOOLS="$ROOT/.tools"
BIN="$ROOT/desktop/resources/bin"
MODELS="$ROOT/desktop/resources/models"
WHISPER_TAG="v1.9.5"
WHISPER_MODEL="${SCRIBE_WHISPER_MODEL:-ggml-large-v3-turbo-q5_0.bin}"
LLM_MODEL="${SCRIBE_LLM:-qwen3.5:9b}"
MODE="${1:-run}"

say() { printf '\n==> %s\n' "$1"; }
fail() { printf '\nSetup stopped: %s\n' "$1" >&2; exit 1; }

say "Checking Node"
command -v node >/dev/null || fail "Node 20 or newer is needed. Install it from https://nodejs.org and run this again."
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 20 ] || fail "Node 20 or newer is needed (found $(node -v))."

say "Installing packages"
(cd "$ROOT" && npm install --no-audit --no-fund)

say "Checking Whisper (speech to text)"
mkdir -p "$BIN" "$MODELS" "$TOOLS"
if [ -x "$BIN/whisper-server" ]; then
  echo "whisper-server is already built."
else
  command -v clang >/dev/null || fail "A C++ compiler is needed. Run: xcode-select --install"
  command -v git >/dev/null || fail "git is needed. Run: xcode-select --install"
  CMAKE="$(command -v cmake || true)"
  if [ -z "$CMAKE" ]; then
    echo "cmake not found; installing a private copy in .tools/"
    python3 -m venv "$TOOLS/venv"
    "$TOOLS/venv/bin/pip" install --quiet --upgrade pip
    "$TOOLS/venv/bin/pip" install --quiet cmake
    CMAKE="$TOOLS/venv/bin/cmake"
  fi
  if [ ! -d "$TOOLS/whisper.cpp" ]; then
    git clone --quiet --depth 1 --branch "$WHISPER_TAG" https://github.com/ggml-org/whisper.cpp "$TOOLS/whisper.cpp"
  fi
  echo "Building whisper.cpp $WHISPER_TAG (a few minutes, once)"
  "$CMAKE" -S "$TOOLS/whisper.cpp" -B "$TOOLS/whisper.cpp/build" \
    -DCMAKE_BUILD_TYPE=Release -DBUILD_SHARED_LIBS=OFF \
    -DWHISPER_BUILD_TESTS=OFF -DWHISPER_BUILD_EXAMPLES=ON >"$TOOLS/whisper-configure.log" 2>&1 \
    || fail "whisper.cpp could not be configured. See .tools/whisper-configure.log"
  "$CMAKE" --build "$TOOLS/whisper.cpp/build" --config Release --target whisper-server -j >"$TOOLS/whisper-build.log" 2>&1 \
    || fail "whisper.cpp could not be built. See .tools/whisper-build.log"
  cp "$TOOLS/whisper.cpp/build/bin/whisper-server" "$BIN/whisper-server"
  echo "Built $BIN/whisper-server"
fi

if [ -s "$MODELS/$WHISPER_MODEL" ]; then
  echo "Whisper model $WHISPER_MODEL is already downloaded."
else
  echo "Downloading Whisper model $WHISPER_MODEL (about 575 MB, once)"
  curl -L --fail --progress-bar -o "$MODELS/$WHISPER_MODEL.part" \
    "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/$WHISPER_MODEL" \
    || fail "The Whisper model could not be downloaded."
  mv "$MODELS/$WHISPER_MODEL.part" "$MODELS/$WHISPER_MODEL"
fi

say "Checking the voice (Kokoro, text to speech)"
TTS_DIR="$MODELS/tts"
if [ -s "$TTS_DIR/kokoro-en-v0_19/model.onnx" ]; then
  echo "The Kokoro voice is already downloaded."
else
  echo "Downloading the Kokoro voice (about 305 MB, once)"
  mkdir -p "$TTS_DIR"
  curl -L --fail --progress-bar -o "$TTS_DIR/kokoro.tar.bz2" \
    "https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/kokoro-en-v0_19.tar.bz2" \
    || fail "The voice could not be downloaded. Scribe works without it, but stays silent."
  tar -xjf "$TTS_DIR/kokoro.tar.bz2" -C "$TTS_DIR" || fail "The voice download could not be unpacked."
  rm -f "$TTS_DIR/kokoro.tar.bz2"
fi

say "Checking Ollama (the local counselor model)"
command -v ollama >/dev/null || fail "Ollama is needed. Install it from https://ollama.com/download and run this again."
if ! curl -s -m 3 http://127.0.0.1:11434/api/version >/dev/null; then
  echo "Starting Ollama"
  (ollama serve >"$TOOLS/ollama.log" 2>&1 &)
  for _ in $(seq 1 20); do
    curl -s -m 2 http://127.0.0.1:11434/api/version >/dev/null && break
    sleep 1
  done
  curl -s -m 3 http://127.0.0.1:11434/api/version >/dev/null || fail "Ollama did not start. See .tools/ollama.log"
fi
if ollama list | awk 'NR>1 {print $1}' | grep -qx "$LLM_MODEL"; then
  echo "Model $LLM_MODEL is already downloaded."
else
  echo "Downloading model $LLM_MODEL (several GB, once)"
  ollama pull "$LLM_MODEL"
fi

say "Building Scribe"
(cd "$ROOT" && npm run build)

case "$MODE" in
  --no-run) say "Setup finished. Start Scribe with: npm start" ;;
  --desktop) say "Starting the desktop app"; cd "$ROOT" && npm run desktop ;;
  *) say "Starting Scribe"; cd "$ROOT" && npm start ;;
esac
