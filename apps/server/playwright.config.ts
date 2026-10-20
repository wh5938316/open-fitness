import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1,
  timeout: 90000,
  use: {
    baseURL: 'http://localhost:18787',
    browserName: 'chromium',
    locale: 'en-US',
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'node scripts/e2e-server.mjs',
    url: 'http://localhost:18787/healthz',
    reuseExistingServer: false,
    timeout: 120000,
  },
});
