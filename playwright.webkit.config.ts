/**
 * The touch tests in WebKit (Safari's engine), on an emulated iPad Pro 11:
 * `npm run test:touch:webkit` (first time: `npx playwright install --with-deps webkit`).
 * Playwright drives real taps in WebKit but not touch drags — see e2e/touch.e2e.ts.
 */
import { defineConfig, devices } from '@playwright/test';
import base from './playwright.config';

export default defineConfig({
  ...base,
  testMatch: '**/touch.e2e.ts',
  use: {
    trace: base.use?.trace,
    baseURL: base.use?.baseURL,
    ...devices['iPad Pro 11 landscape'],
  },
  projects: [{ name: 'webkit-ipad', use: { browserName: 'webkit' } }],
});
