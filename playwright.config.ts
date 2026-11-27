/**
 * Browser tests (Playwright + Chromium) against the Vite dev server: they
 * drive the real app, its AudioContext / OfflineAudioContext and storage.
 * Run with `npm run test:e2e` (first time: `npx playwright install chromium`, or point
 * PLAYWRIGHT_CHROMIUM_PATH at an installed Chromium).
 */
import { defineConfig, devices } from '@playwright/test';

const PORT = 5199;

export default defineConfig({
  testDir: 'e2e',
  testMatch: '**/*.e2e.ts',
  timeout: 180_000,
  fullyParallel: false,
  workers: 1,
  // no retries: a flaky test should show up, not be hidden
  retries: 0,
  forbidOnly: !!process.env.CI,
  // CI also writes an HTML report (uploaded when a run fails) and keeps traces of failures
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : [['list']],
  use: {
    trace: process.env.CI ? 'retain-on-failure' : 'off',
    baseURL: `http://127.0.0.1:${PORT}`,
    ...devices['Desktop Chrome'],
    launchOptions: {
      args: ['--autoplay-policy=no-user-gesture-required'],
      // use an already installed Chromium instead of Playwright's own download, if given
      ...(process.env.PLAYWRIGHT_CHROMIUM_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH } : {}),
    },
  },
  webServer: {
    command: `npx vite --port ${PORT} --strictPort --host 127.0.0.1`,
    url: `http://127.0.0.1:${PORT}`,
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
});
