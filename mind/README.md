# SHIVA's mind

The Python half. It listens, thinks (Claude, on your existing subscription),
speaks, acts on your Mac and the devices on your Wi-Fi, watches your inbox
(Shruti), remembers (Smriti), and recognises you at the gate (Nandi).

**It has no interface of its own any more.** The HUD it shipped with was
replaced by the spatial interface in the repository root, and everything below
about opening `localhost:8377` now means `localhost:3000` instead. What still
runs on 8377 is a small read API the config and connector screens use.

Start both halves together from the repository root with `./shiva`. See
`../MIND.md` for how the two are wired, and what the rename changed.

---

## 1. Install (once, ~10 minutes + model download)

```bash
cd SHIVA
chmod +x setup.sh && ./setup.sh
```

Prerequisites the script checks/installs: Homebrew, ffmpeg, portaudio,
Node + **Claude Code CLI** (run `claude` once and log in — SHIVA's brain uses
your Claude subscription through it), `playactor` (PS5), Python venv + deps.

Then edit `.env` (created from `.env.example`):

| Setting | Where to get it |
|---|---|
| `ELEVENLABS_API_KEY` | elevenlabs.io → Profile → API Keys |
| `PICOVOICE_ACCESS_KEY` | console.picovoice.ai (free) — until set, push-to-talk works |
| `MAC2_SSH` | second Mac: System Settings → Sharing → **Remote Login** on, then `ssh-copy-id user@ip` from this Mac |
| `PS5_IP` | router's client list; pair once: `playactor wake --ip <IP>` (follow sign-in prompt) |
| `MY_IMESSAGE` | your own phone number / Apple ID email — SHIVA pings your iPhone via iMessage |
| `GMAIL_ADDRESS` + `GMAIL_APP_PASSWORD` | myaccount.google.com/apppasswords (needs 2FA on) |

## 2. Run

```bash
source .venv/bin/activate
python -m shiva          # voice mode
python -m shiva --text   # typed mode (no mic) — perfect for first test
```

Open the HUD: **http://localhost:8377**, full-screen it on the big display,
and **click once** — that unlocks the browser's audio so SHIVA's voice plays
through the HUD with live avatar lip-sync. (No click → SHIVA automatically
speaks through the Mac instead; the avatar still animates by state.)

Terminal controls, any time:
- **Type a command + Enter** → same as speaking it (great for rehearsal)
- **Enter on empty line** → push-to-talk (listen now, no wake word needed)
- Wake word: **"Jarvis"** built-in until you train **"Hey SHIVA"** at
  console.picovoice.ai (macOS/arm64) and set `SHIVA_WAKE_PPN`.

macOS permission prompts on first use — grant them: **Microphone** (terminal),
**Camera** (terminal), **Automation/Accessibility** (AppleScript, Messages).

## 2b. Nandi — teach SHIVA your face (the cold open)

```bash
python -m shiva.enroll --name "Boss"     # look at camera, turn head slowly
```

Then run SHIVA. When you appear on camera after being away (>2 min default),
SHIVA greets you unprompted — *"Good morning, Boss. Shall I brief you?"* —
and **opens the mic automatically** so you can just answer "yes". The HUD
shows **◉ BOSS · VERIFIED** in gold; unknown faces get **◉ GUEST · UNKNOWN**
(plus a spoken challenge if `HEIMDALL_GREET_GUESTS=1`). Enroll in demo-room
lighting; re-running adds more samples. Biometrics = embeddings only, stored
locally in `data/nandi.json` — nothing leaves the Mac (that's the pitch
line too). Two small ONNX models (~40 MB) auto-download on first run.

## 2c. The Council — live avatars

The HUD shows four animated characters: **SHIVA** center (jaw, eye-glow and
aura driven by the *actual live waveform* of his voice), with **Shruti**
(flares when an email is intercepted), **Smriti** (flares on memory/HUD
cards), and **Nandi** (flares on face recognition) beneath him.

Want photoreal? Generate portraits with any image AI and drop them into
`hud/avatars/` as `shiva.png`, `shruti.png`, `smriti.png`, `nandi.png` —
they're picked up automatically and animated (breathing, speech glow).
See `hud/avatars/README.txt` for prompt ideas.

## 3. Try these first

```
brief me
scan the network
open Keynote
set the volume to 40
wake up the playstation
ping my iphone saying the demo works
make the other mac say hello
remember that I take my coffee black
what do you remember about me?
```

Send yourself an email while SHIVA runs — Shruti announces it within ~20s
and offers to draft a reply (drafts land in Gmail Drafts; nothing auto-sends).

## 4. Notes & known limits (honest list)

- **PS5**: wake + standby only (protocol limitation for all third-party tools).
  First `playactor` run is an interactive pairing.
- **iPhone**: no public API for direct control; SHIVA pings it via
  iMessage-to-self (instant, reliable) or a Pushcut webhook.
- **HUD audio**: needs one click after opening the page (browser autoplay
  policy). Without it SHIVA falls back to speaking through the Mac.
- **Latency**: replies speak after each assistant turn completes; a
  partial-streaming upgrade is the next optimization.
- **Whisper first run** downloads ~1.6 GB. For faster testing:
  `WHISPER_MODEL=mlx-community/whisper-small-mlx`.
- ElevenLabs down / no key → automatic macOS voice fallback. SHIVA never goes mute.

## 5. Project layout

```
shiva/__main__.py     entrypoint, terminal controls, greeting flow
shiva/brain.py        Claude Agent SDK session + SHIVA persona (+ dev mode)
shiva/ears.py         wake word → VAD recording → MLX Whisper
shiva/voice.py        ElevenLabs TTS → HUD lip-sync playback (ffplay/say fallback)
shiva/nandi.py     face recognition (YuNet + SFace, all-local)
shiva/enroll.py       face enrollment CLI
shiva/shruti.py       Gmail watcher + draft_email tool
shiva/smriti.py       durable memory
shiva/tools_mac.py    AppleScript / apps / volume / calendar / HUD / memory tools
shiva/tools_devices.py  network scan, second Mac (SSH), PS5, iPhone
shiva/bus.py          WebSocket event bus + HUD web server
hud/index.html       the Gana of Kailash HUD
hud/avatars/         drop custom portrait PNGs here
```
