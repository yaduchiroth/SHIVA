# Deploying SHIVA to Hostinger

Written for a git-pull deploy onto a Hostinger Node.js host.

The build and serve sequence below has been **run and verified** against a clean
clone: standalone output builds, the asset-copy steps produce a correctly styled
page, `PORT`/`HOSTNAME` binding works, the COOP/COEP headers survive to the
response, and `/models/hand_landmarker.task` serves all 7.8 MB. What has _not_
been exercised is Hostinger's own proxy and SSL, which is where the remaining
risk sits — hence the verification section at the end.

## Before you start: what this app needs from a host

SHIVA is not a typical Next.js site, and three of its requirements are easy to
miss until something silently degrades:

1. **HTTPS is mandatory, not preferred.** `getUserMedia` refuses to run outside a
   secure context. Over plain HTTP the app loads fine and reports the camera as
   unavailable — hand tracking simply never starts, with no error to chase.
   Hostinger issues free SSL; make sure it's active on the domain before
   concluding tracking is broken.
2. **Two response headers decide MediaPipe's speed.** `next.config.ts` sets
   `Cross-Origin-Opener-Policy: same-origin` and
   `Cross-Origin-Embedder-Policy: credentialless`, which let the vision WASM use
   threaded inference. A reverse proxy that strips them costs roughly half the
   tracking throughput, and again there's no error — just a slower number in the
   HUD's inference readout.
3. **Outbound network during install.** `postinstall` downloads the 7.8 MB
   hand-landmarker model from Google's servers. Locked-down hosts block this.

## 1. Prepare the build output

Set `BUILD_STANDALONE=1` at build time. `next.config.ts` reads it and switches on
Next's standalone output, which emits a self-contained server with only the
dependencies it actually needs — meaningfully smaller than shipping the full
`node_modules`, which matters on constrained hosting. The flag is off by default
so local development is untouched.

## 2. On the server

```bash
git clone -b claude/personal-agentic-ai-ny97hn https://github.com/yaduchiroth/SHIVA.git
cd SHIVA
node -v                      # must be 20.9 or newer
npm ci
BUILD_STANDALONE=1 npm run build
```

Then assemble the standalone bundle. Next deliberately does **not** copy static
assets into it, and missing this step is the single most common standalone
deployment failure — the site loads with no CSS and no MediaPipe assets:

```bash
cp -r public .next/standalone/public
cp -r .next/static .next/standalone/.next/static
```

Start it:

```bash
cd .next/standalone
PORT=${PORT:-3000} HOSTNAME=0.0.0.0 node server.js
```

`HOSTNAME=0.0.0.0` matters: bound to `localhost` the process is unreachable from
the host's reverse proxy, which presents as a 502 with a perfectly healthy-looking
Node process.

### If the model download is blocked

Run `npm run assets` on your own machine, then copy `public/models/` and
`public/mediapipe/` up via SFTP. Both are gitignored precisely because binaries
don't belong in git. If you skip this, the app still works — it reports hand
tracking as unavailable and falls back to pointer control, honestly.

## 3. Keep it running

**VPS with SSH** — use pm2 so it survives crashes and reboots:

```bash
npm install -g pm2
cd ~/SHIVA/.next/standalone
PORT=3000 HOSTNAME=0.0.0.0 pm2 start server.js --name shiva
pm2 save && pm2 startup
```

**hPanel Node.js app manager** — point the app root at the repo, set the startup
file to `.next/standalone/server.js`, and set `BUILD_STANDALONE=1` in its
environment. The manager supplies `PORT` itself; don't hard-code one.

## 4. Verify, in this order

```bash
curl -I https://your-domain
```

- `200` — the server is up.
- `cross-origin-opener-policy: same-origin` and
  `cross-origin-embedder-policy: credentialless` present — if the proxy stripped
  them, add them back in the Nginx server block with `add_header ... always`.
- Open the site and check the HUD: **QUALITY** shows the auto-selected tier and
  **RENDER** shows a live frame rate. If they're populated, the render loop is
  running.
- Click **Enable hand tracking**. On HTTPS you'll get a camera prompt; the
  tracking cluster then shows hand count and inference time. If it says
  "Camera requires HTTPS or localhost", SSL isn't actually terminating where you
  think it is.

## Updating later

```bash
cd ~/SHIVA && git pull
npm ci && BUILD_STANDALONE=1 npm run build
cp -r public .next/standalone/public
cp -r .next/static .next/standalone/.next/static
pm2 restart shiva
```

The two `cp` lines are needed on every rebuild — `.next` is regenerated from
scratch each time, so stale static assets are the usual cause of an update that
"deployed fine" but renders unstyled.

## Phase 2 note

When the Gemini brain lands, `GEMINI_API_KEY` goes in the server environment —
never in the repo, and never behind a `NEXT_PUBLIC_` prefix, which would ship it
to every visitor's browser. See `.env.example`.
