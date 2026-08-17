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
