import { defineConfig, devices } from '@playwright/test';

const PORT = Number(process.env.PLAYWRIGHT_TEST_PORT || 4173);
process.env.PLAYWRIGHT_TEST_PORT = String(PORT);
const REMOTE_BASE = process.env.PLAYWRIGHT_BASE_URL;
const BASE_URL = REMOTE_BASE || `http://127.0.0.1:${PORT}`;
const isRemote = /^https?:\/\//i.test(BASE_URL) && !BASE_URL.includes('127.0.0.1');

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 2 : 0,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: BASE_URL,
    trace: 'on-first-retry',
    video: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: isRemote
    ? undefined
    : {
        command: `npm run dev --workspace mini-app -- --host --port ${PORT}`,
        url: BASE_URL,
        reuseExistingServer: false,
        timeout: 120_000,
      },
});
