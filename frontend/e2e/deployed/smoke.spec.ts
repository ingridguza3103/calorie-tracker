import { expect, test } from '@playwright/test'
import { expectFitsScreen } from '../helpers'

test('deployed build wakes, serves its API, and fits the screen without signing in', async ({ page, request, baseURL }) => {
  await expect.poll(async () => {
    try {
      const response = await request.get('/api/ready', { timeout: 15_000 })
      return response.status() === 200 && (await response.json()).database === 'connected'
    } catch { return false }
  }, { timeout: 120_000, intervals: [1000, 2000, 5000] }).toBe(true)

  const health = await request.get('/api/health')
  expect(health.status()).toBe(200)
  expect(await health.json()).toEqual({ status: 'ok' })

  await page.goto('/')
  expect(new URL(page.url()).origin).toBe(baseURL)
  await expect(page.getByRole('heading', { name: 'Welcome back.' })).toBeVisible()
  await expectFitsScreen(page)
  await page.getByRole('button', { name: 'Sign up', exact: true }).click()
  await expect(page.getByLabel('Password', { exact: true })).toHaveAttribute('minlength', '8')
  await expectFitsScreen(page)
  await page.getByRole('button', { name: 'Switch to dark mode' }).click()
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
  await expectFitsScreen(page)
  await page.reload()
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
  await expect(page.getByRole('heading', { name: 'Welcome back.' })).toBeVisible()

  for (const path of ['/api/auth/me', '/api/profile', '/api/plan', '/api/diary?date=2026-01-01', '/api/food/estimates/1']) {
    const response = await request.get(path)
    expect(response.status()).toBe(401)
    expect(response.headers()['cache-control']).toBe('no-store')
  }
})
