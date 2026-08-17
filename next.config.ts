import type { NextConfig } from 'next'

const nextConfig: NextConfig = {
  reactStrictMode: true,

  // Standalone output emits a self-contained server with only the dependencies
  // it actually needs — worth a lot on constrained hosting, where shipping the
  // full node_modules is the difference between a deploy fitting and not.
  //
  // Gated behind an env var rather than always-on because standalone changes
  // how the app is started (`node .next/standalone/server.js`, not
  // `next start`), and local development shouldn't have to care. See DEPLOY.md.
  ...(process.env.BUILD_STANDALONE ? { output: 'standalone' as const } : {}),

  // SHIVA has no images. Not one — the entire interface is a WebGL canvas plus
  // text, and every panel face is drawn with Canvas2D at runtime.
  //
  // Saying so matters for deployment. Next's image optimizer pulls in `sharp`,
  // which is 33 MB of the standalone bundle and the ONLY part of it containing
  // compiled native binaries. Those are built for the machine that built them,
  // so their presence is exactly what stops you building on a Mac and uploading
  // to a Linux host — for an optimizer that would never be asked to optimize
  // anything.
  //
  // This flag alone does NOT keep sharp out of a standalone bundle: Next copies
  // its own server runtime wholesale, and `outputFileTracingExcludes` does not
  // reach it either — both were tried and neither changed the output by a byte.
  // scripts/pack.mjs prunes it afterwards instead, which does work and is
  // verified. The flag stays because it is true and it stops the optimizer
  // being invoked at all.
  images: { unoptimized: true },

  // three.js and the R3F ecosystem ship ESM that benefits from being transpiled
  // alongside the app rather than treated as opaque externals.
  transpilePackages: ['three'],

  // MediaPipe's vision WASM needs cross-origin isolation to use SharedArrayBuffer
  // and threaded inference. Without these headers it silently falls back to the
  // single-threaded path, which roughly halves hand-tracking throughput.
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'Cross-Origin-Opener-Policy', value: 'same-origin' },
          { key: 'Cross-Origin-Embedder-Policy', value: 'credentialless' },
        ],
      },
      {
        // The landmarker model is content-addressed by version and never mutates.
        source: '/models/:path*',
        headers: [{ key: 'Cache-Control', value: 'public, max-age=31536000, immutable' }],
      },
      {
        source: '/mediapipe/:path*',
        headers: [{ key: 'Cache-Control', value: 'public, max-age=31536000, immutable' }],
      },
    ]
  },
}

export default nextConfig
