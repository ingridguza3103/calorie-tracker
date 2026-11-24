import { defineConfig, devices } from '@playwright/test'

const port = Number(process.env.E2E_PORT ?? 18002)
export default defineConfig({
  testDir: './e2e/local',
  fullyParallel: false,
  workers: 1,
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  timeout: 45_000,
  expect: { timeout: 10_000 },
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: 'http://127.0.0.1:' + port,
    serviceWorkers: 'block',
    timezoneId: 'Pacific/Auckland',
    locale: 'en-GB',
    trace: 'off',
    screenshot: 'off',
    video: 'off',
  },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'], viewport: { width: 1366, height: 900 } } },
    { name: 'android-small', use: { ...devices['Pixel 5'], viewport: { width: 360, height: 800 } } },
    { name: 'iphone', use: { ...devices['iPhone 14 Pro Max'] } },
  ],
  webServer: {
    command: 'python ../scripts/e2e_app.py',
    url: 'http://127.0.0.1:' + port + '/api/ready',
    timeout: 60_000,
    reuseExistingServer: false,
    gracefulShutdown: { signal: 'SIGTERM', timeout: 10_000 },
    stdout: 'pipe',
    stderr: 'pipe',
  },
})
