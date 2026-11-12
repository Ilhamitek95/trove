'use strict';
// Browser end-to-end journeys. Run from this folder:  npm install && npx playwright test
// E2E_PORT picks the port (default 4390) so two runs can sit side by side.
const { defineConfig, devices } = require('@playwright/test');

const PORT = Number(process.env.E2E_PORT || 4390);
const baseURL = `http://localhost:${PORT}`;

module.exports = defineConfig({
  testDir: './tests',
  timeout: 90_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 2,
  retries: 0,
  // Per-port output folders, so two runs side by side never wipe each other's traces.
  reporter: [['list'], ['html', { open: 'never', outputFolder: `playwright-report-${PORT}` }]],
  outputDir: `test-results-${PORT}`,
  use: {
    baseURL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    viewport: { width: 1280, height: 860 },
    locale: 'en-GB',
    timezoneId: 'Asia/Dubai',
  },
  projects: [
    { name: 'desktop', testIgnore: /\.mobile\.spec\.js$/, use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 860 } } },
    { name: 'iphone', testMatch: /\.mobile\.spec\.js$/, use: { ...devices['iPhone 14'] } },   // WebKit = iPhone Safari
  ],
  webServer: {
    command: 'node start-server.js',
    url: `${baseURL}/api/health`,
    reuseExistingServer: false,
    timeout: 60_000,
    env: { E2E_PORT: String(PORT) },
    stdout: 'ignore',
    stderr: 'pipe',
  },
});
