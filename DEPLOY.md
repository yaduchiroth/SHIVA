# Deploying SHIVA to Hostinger

Written for the **hPanel Node.js application manager**. The VPS/SSH route is at
the end.

Everything up to §4 has been run end to end in a Linux container: the archive is
built, extracted into a bare directory with nothing else in it, and started
exactly the way hPanel starts it. It boots in 102 ms, serves the whole app with
**zero failed requests**, the COOP/COEP headers survive, credentials load, and a
headless browser paints the interface. What has **not** been exercised is
Hostinger's own Passenger wrapper, SSL and reverse proxy — §5 is an ordered
ladder so that whichever of those fails, one command tells you which.

---

## What this app needs from a host

Three requirements that fail _silently_. Each produces a working site with
something quietly missing rather than an error you can chase.

1. **HTTPS is mandatory, not preferred.** `getUserMedia` refuses to run outside a
   secure context, so over plain HTTP the app loads perfectly and reports the
   camera as unavailable. Same for the microphone, so live voice dies with it.
   Hostinger issues free SSL — confirm it is active before concluding that
   tracking is broken.
2. **Two response headers decide MediaPipe's speed.** `next.config.ts` sets
   `Cross-Origin-Opener-Policy: same-origin` and
   `Cross-Origin-Embedder-Policy: credentialless`, which let the vision WASM use
   threaded inference. A proxy that strips them costs roughly half the tracking
   throughput, with no error — just a worse number in the HUD.
3. **Node 20.9 or newer.**

---

## Don't build on the server

Build on your Mac and upload the finished bundle. Three reasons, all specific to
managed hosting:

- `next build` compiles three.js, React Three Fiber and a postprocessing chain.
  On a memory-constrained plan that is a realistic OOM kill, and an OOM during a
  Next build presents as a truncated log rather than an error naming the cause.
- Building needs the repo plus roughly a gigabyte of `node_modules`. The finished
  bundle is 91 MB and carries its own.
- `postinstall` fetches a 7.8 MB model from Google. A host that blocks outbound
  traffic costs you hand tracking, silently.

Standalone output exists so none of that has to happen on the server.

---

## 1. Build the bundle, on your Mac — verified

```bash
cd ~/SHIVA
git pull origin claude/personal-agentic-ai-ny97hn
npm ci
npm run bundle
```

That produces **`shiva-deploy.tar.gz`, about 27 MB**, and prints what it did:

```
  public/          43.3 MB
  .next/static/    4.4 MB
  .env.local       copied
  pruned @img      34.4 MB (image optimizer; this app has no images)
  hand landmarker  7.8 MB
  mediapipe wasm   35.4 MB
  No native binaries — safe to build on one platform and run on another.
  shiva-deploy.tar.gz   27.2 MB
```

Two of those lines are the reason this is one command rather than a checklist:

**`public/` and `.next/static/` are copied.** Next's standalone output
deliberately omits both — it does not presume to know how you serve static files
— so the naive deploy boots, returns 200, and renders with no CSS and no hand
tracking, with nothing in any log. It is the single most common way a standalone
Next deploy goes wrong.

**`@img` is pruned.** `sharp` is Next's image optimizer, and it is the only thing
in the bundle containing compiled native binaries — built for the machine that
built them, and therefore exactly what would stop a Mac-built bundle running on
Linux. SHIVA has no images at all, so it is removed: a quarter of the bundle and
the whole portability problem, gone. The script then _checks_ that no native
binaries remain rather than assuming.

The archive contains `.env.local`, so **it holds your API keys** — don't share
it, and delete it once uploaded. `npm run bundle -- --no-env` omits it if you'd
rather set credentials in hPanel.

---

## 2. Upload and extract — verified

hPanel → **File Manager**, or SFTP. Upload `shiva-deploy.tar.gz` and extract it
into the directory you will use as the application root — say `~/shiva`.

**Extract the contents, not into a subdirectory.** `server.js` must sit directly
in the app root. Afterwards it should look exactly like this:

```
~/shiva/
  server.js
  package.json
  node_modules/
  public/
  .next/
  .env.local
```

This layout is not incidental. Next's standalone `server.js` calls
`process.chdir(__dirname)` before doing anything, so everything it looks for has
to be beside it. Making the app root **be** that directory means the layout hPanel
expects and the layout the server expects are the same one — and the
`.env.local`-in-the-wrong-place trap that cost us two rounds this week cannot
recur, because the file is simply in the app root where anyone would put it.

If File Manager cannot extract `.tar.gz`, unpack it on your Mac
(`tar -xzf shiva-deploy.tar.gz -C shiva/`) and upload the folder's contents.

---

## 3. Configure the Node app — verified locally

hPanel → **Advanced → Node.js**:

| Field            | Value       |
| ---------------- | ----------- |
| Application root | `~/shiva`   |
| Application URL  | your domain |
| Startup file     | `server.js` |
| Node version     | 20 or 22    |

Leave the port alone — the panel assigns one and passes it as `PORT`, which
`server.js` reads. Hard-coding a port is how you get a 502 from a process that
looks perfectly healthy in its log.

**Do not press "Run NPM Install".** The bundle carries its own `node_modules`,
pruned and verified; installing would pull a different dependency tree over the
top of it and drag `sharp` back in.

Then **Restart** the application.

---

## 4. Credentials

Already handled — `npm run bundle` put `.env.local` in the archive, and §2 put it
in the app root, which is where `server.js` reads it from. Verified: with the
file one directory higher the app reports `no-key`; beside `server.js` it reports
`ready`.

To change a key later, edit `~/shiva/.env.local` in File Manager and restart the
app. Environment is read once at boot, so the restart is required.

Never prefix any of these with `NEXT_PUBLIC_` — that ships the value to every
visitor's browser.

---

## 5. Verify, in this order

Each step isolates one layer, so a failure tells you _which_ layer.

```bash
curl -I https://your-domain
```

- **`200`** — the server is up and the proxy reaches it. A 502 here with a
  healthy Node log means the port binding; check you left `PORT` to the panel.
- **`cross-origin-opener-policy: same-origin`** and
  **`cross-origin-embedder-policy: credentialless`** present. If Hostinger's
  proxy stripped them, hand tracking still works but at roughly half speed.

```bash
curl -s https://your-domain/api/brain
```

- **`{"status":"ready","model":"..."}`** — credentials arrived and Google accepts
  them.
- **`{"status":"no-key"}`** — `.env.local` is not in the app root. See §2.
- **`{"status":"rejected","detail":"..."}`** — the detail is Google's own words
  and names the fix.

```bash
curl -s -o /dev/null -w "%{http_code} %{size_download}\n" \
  https://your-domain/models/hand_landmarker.task
```

- **`200 7819105`** — static assets are being served. A 404 means the extraction
  in §2 landed in a subdirectory.

Then open the site:

- **QUALITY** and **RENDER** in the HUD are populated → the render loop is live.
- Click **Enable hand tracking** → camera prompt, then a hand count.
  "Camera requires HTTPS or localhost" means SSL is not terminating where you
  think it is.

---

## Updating later

```bash
cd ~/SHIVA
git pull
npm ci
npm run bundle
```

Upload and extract over `~/shiva` again, then Restart in hPanel. `.next` is
regenerated from scratch every build, so this whole cycle is needed each time —
stale static assets are the usual cause of an update that "deployed fine" and
renders unstyled.

---

## Alternative: VPS with SSH

If the plan turns out to have SSH, building on the server is a better workflow —
`git pull` and rebuild in place, no upload.

```bash
git clone -b claude/personal-agentic-ai-ny97hn https://github.com/yaduchiroth/SHIVA.git
cd SHIVA && npm ci && npm run build:standalone

npm install -g pm2
cd .next/standalone
PORT=3000 HOSTNAME=0.0.0.0 pm2 start server.js --name shiva
pm2 save && pm2 startup
```

`HOSTNAME=0.0.0.0` is not optional behind a reverse proxy: bound to `localhost`
the process is unreachable and presents as a 502 with a completely healthy
looking log — an hour spent debugging the wrong layer.

Update with `git pull && npm ci && npm run build:standalone && pm2 restart shiva`.
