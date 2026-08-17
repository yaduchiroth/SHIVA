import { defineConfig, devices } from '@playwright/test'

/**
 * WebGL in CI runs on SwiftShader (software rasterisation), so real frame-rate
 * numbers are meaningless here — the performance spec asserts the app stays
 * responsive and doesn't leak frames, not that it hits 60fps on a CPU.
 */
export default defineConfig({
  testDir: './tests',
  fullyParallel: false, // One GPU-ish context at a time; parallel WebGL contexts thrash.
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : [['list']],
  timeout: 180_000,
  expect: { timeout: 20_000 },

  use: {
    baseURL: 'http://127.0.0.1:3111',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    // Camera permission is granted up front so the tracking path can be
    // exercised headlessly against a synthetic feed.
    permissions: ['camera'],
  },

  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        // Small on purpose: CI rasterises in software, and its cost scales
        // directly with pixel count. 1440x900 takes seconds per frame here.
        viewport: { width: 900, height: 640 },
        launchOptions: {
          args: [
            // Software GL: CI has no real GPU, and without this the context
            // fails to create at all rather than falling back.
            '--use-gl=swiftshader',
            '--enable-unsafe-swiftshader',
            '--no-sandbox',
            '--disable-dev-shm-usage',
            // A synthetic camera so getUserMedia resolves and the landmarker
            // runs end-to-end. It shows a moving pattern, not hands, so no
            // gesture assertions depend on it — only that the pipeline starts.
            '--use-fake-device-for-media-stream',
            '--use-fake-ui-for-media-stream',
            '--autoplay-policy=no-user-gesture-required',
          ],
        },
      },
    },
  ],

  webServer: {
    command: 'npm run build && npx next start -p 3111',
    url: 'http://127.0.0.1:3111',
    reuseExistingServer: !process.env.CI,
    timeout: 300_000,
    stdout: 'ignore',
    stderr: 'pipe',
  },
})
