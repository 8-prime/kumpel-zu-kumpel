import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  timeout: 90_000,
  expect: { timeout: 15_000 },
  workers: 1,
  use: {
    baseURL: 'http://127.0.0.1:5173',
    screenshot: 'only-on-failure',
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'], channel: process.env.PLAYWRIGHT_CHANNEL || undefined } },
    { name: 'firefox', use: { ...devices['Desktop Firefox'] } },
  ],
  webServer: [
    { command: 'cargo run -p server --offline', cwd: '../backend', port: 3000, reuseExistingServer: !process.env.CI, timeout: 120_000 },
    { command: 'npm run dev', port: 5173, reuseExistingServer: !process.env.CI, timeout: 30_000 },
  ],
});
