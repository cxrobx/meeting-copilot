import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, devices } from '@playwright/test';

/**
 * The ship gate (docs/quality-plan.md §5, C1): six WebKit specs against the
 * packaged server, run by scripts/ship.sh before it touches /Applications.
 * WebKit because that is the engine WKWebView uses; Chromium is not a
 * stand-in (gotcha #27 was a painting difference).
 *
 *   cd server && npm run e2e                  # the packaged dist/ bundle
 *   MC_E2E_SERVER=. npm run e2e               # this checkout's server/dist (after tsc)
 *
 * @playwright/test is pinned to 1.61.1: newer drivers cannot run the frozen
 * WebKit Playwright ships for macOS 14 (gotcha #30).
 */
const outputDir = process.env.MC_E2E_OUT ?? join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'dist', 'e2e');

export default defineConfig({
  testDir: '.',
  testMatch: /\d\d-.*\.spec\.ts$/,
  globalSetup: './harness.ts',
  outputDir,
  // One server, one browser: the specs share the seeded meeting, and the
  // live-session spec changes the server's state.
  workers: 1,
  fullyParallel: false,
  retries: 0,
  forbidOnly: true,
  timeout: 20_000,
  globalTimeout: 90_000,
  expect: { timeout: 5_000 },
  reporter: [['list']],
  use: {
    ...devices['Desktop Safari'],
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 1,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'webkit', use: { browserName: 'webkit' } }],
});
