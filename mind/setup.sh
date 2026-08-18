#!/bin/bash
# SHIVA setup — run once on the MacBook Pro:  ./setup.sh
set -e
cd "$(dirname "$0")"

bold() { printf "\033[1;33m%s\033[0m\n" "$1"; }

bold "── SHIVA setup ──────────────────────────────────────"

# 1. Homebrew packages
if ! command -v brew >/dev/null; then
  echo "Homebrew is required → https://brew.sh"; exit 1
fi
bold "[1/6] Homebrew packages (ffmpeg, portaudio, ical-buddy)…"
brew list ffmpeg >/dev/null 2>&1 || brew install ffmpeg
brew list portaudio >/dev/null 2>&1 || brew install portaudio
brew list ical-buddy >/dev/null 2>&1 || brew install ical-buddy || true

# 2. Node + Claude Code CLI (SHIVA's brain auth rides on your Claude subscription)
bold "[2/6] Claude Code CLI…"
if ! command -v node >/dev/null; then brew install node; fi
if ! command -v claude >/dev/null; then npm install -g @anthropic-ai/claude-code; fi
echo "    → If you haven't yet: run 'claude' once and log in with your Claude account."

# 3. playactor for the PS5 (optional)
bold "[3/6] playactor (PS5 control, optional)…"
command -v playactor >/dev/null || npm install -g playactor || true

# 4. Python env
bold "[4/6] Python environment…"
python3 -m venv .venv
source .venv/bin/activate
pip install --upgrade pip -q
pip install -r requirements.txt

# 5. The interface
#
# Both halves are one repository now, and setting up half of a thing is how you
# discover the other half at the least convenient moment. Runs in the root, not
# here — `npm install` there also vendors the MediaPipe WASM and downloads the
# hand-landmarker model.
bold "[5/6] Interface dependencies…"
( cd .. && npm install )

# 6. Config
bold "[6/6] Config…"
[ -f .env ] || cp .env.example .env
echo ""
bold "── Done. Next steps ────────────────────────────────"
echo "  1. Edit mind/.env  (ElevenLabs key, devices, Gmail app password)"
echo "  2. From the repository root:  ./shiva"
echo "  3. The interface opens at http://localhost:3000 — click once anywhere,"
echo "     which is what lets the browser play SHIVA's voice."
echo "  4. Grant mic + camera permission to your terminal when macOS asks."
echo ""
echo "  First run downloads the Whisper model (~1.6 GB) — do this on good Wi-Fi."
echo ""
echo "  The interface is served by Next from the repository root, so it needs"
echo "  npm install there too if you have not run it yet."
