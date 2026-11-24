import { defineConfig, devices } from '@playwright/test'

const supplied = process.env.E2E_BASE_URL ?? 'https://calorie-tracker-e6b4.onrender.com'
const target = new URL(supplied)
if (target.protocol !== 'https:' || target.username || target.password ||
  target.pathname !== '/' || target.search || target.hash)
  throw new Error('E2E_BASE_URL must be an HTTPS origin without credentials or a path.')

export default defineConfig({
  testDir: './e2e/deployed',
  workers: 1,
  retries: 0,
  timeout: 180_000,
  expect: { timeout: 15_000 },
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: target.origin,
    serviceWorkers: 'block',
    navigationTimeout: 120_000,
    actionTimeout: 15_000,
    trace: 'off',
    screenshot: 'off',
    video: 'off',
  },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'], viewport: { width: 1366, height: 900 } } },
    { name: 'android-small', use: { ...devices['Pixel 5'], viewport: { width: 360, height: 800 } } },
    { name: 'iphone', use: { ...devices['iPhone 14 Pro Max'] } },
  ],
})
