#!/usr/bin/env node
/**
 * Production entry point, for hosts that start an application by filename.
 *
 * `next start` is an npm script, and managed Node panels — Hostinger's, cPanel's,
 * anything built on Passenger — ask for an "Application startup file": a real
 * path they hand to Node. Without one there is nothing to point them at, which
 * is what stops this repository deploying through the automatic installer.
 *
 * It is deliberately thin. Everything of substance still lives in Next; this
 * exists to be a filename, to read the port the panel assigns, and to fail
 * comprehensibly when the build is missing.
 *
 * Written as CommonJS on purpose, despite the rest of the project being ESM.
 * `package.json` has no `"type": "module"`, so an ESM version of this file makes
 * Node print a MODULE_TYPELESS_PACKAGE_JSON warning and reparse it — harmless,
 * but it lands at the top of the panel's log, which is frequently the only
 * window anyone has into what the process did. Adding `"type": "module"` would
 * fix that by reclassifying every `.js` file in the project, which is a large
 * change to make for a startup shim. CommonJS costs nothing here and is what
 * these panels expect.
 */
const { createServer } = require('node:http')
const { existsSync } = require('node:fs')
const { join } = require('node:path')

const ROOT = __dirname

/**
 * Bind to every interface, not just loopback.
 *
 * Behind a reverse proxy — which is every managed host — a process bound to
 * `localhost` is unreachable, and the failure is a 502 from the proxy while the
 * application's own log looks completely healthy. That combination sends people
 * to debug the wrong layer, so this defaults outward and lets HOSTNAME override.
 */
const host = process.env.HOSTNAME || '0.0.0.0'

// The panel assigns a port and passes it in. Hard-coding one is the other half
// of the 502 described above.
const port = Number(process.env.PORT) || 3000

/**
 * Refuse early, and say which button to press.
 *
 * These panels reliably run `npm install`; whether they also run the build
 * varies. Without `.next`, Next throws "Could not find a production build" —
 * true, but it does not tell someone standing in a hosting control panel what to
 * do about it, and it arrives inside a crash loop they may not be reading.
 */
if (!existsSync(join(ROOT, '.next'))) {
  console.error('SHIVA cannot start: there is no production build in .next/')
  console.error('')
  console.error('The install step ran, but the build step did not. Run it:')
  console.error('')
  console.error('    npm run build')
  console.error('')
  console.error('In hPanel that is Advanced → Node.js → Run JS script → build.')
  console.error('Over SSH, run it in the application root.')
  process.exit(1)
}

const next = require('next')
const app = next({ dev: false, dir: ROOT })
const handle = app.getRequestHandler()

app
  .prepare()
  .then(() => {
    createServer((req, res) => {
      handle(req, res).catch((err) => {
        // A handler that rejects would otherwise hang the request until the
        // client gives up, which reads as a network fault rather than an
        // application one.
        console.error('[server] request failed:', err)
        res.statusCode = 500
        res.end('Internal Server Error')
      })
    }).listen(port, host, () => {
      // Printed because the panel's log is often the only window into what the
      // process actually did, and "which port did it take" is the first question
      // asked when the proxy returns 502.
      console.log(`SHIVA listening on http://${host}:${port}`)
    })
  })
  .catch((err) => {
    console.error('SHIVA failed to start:', err)
    process.exit(1)
  })
