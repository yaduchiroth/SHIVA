import type { NextConfig } from 'next'

const nextConfig: NextConfig = {
  reactStrictMode: true,

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
