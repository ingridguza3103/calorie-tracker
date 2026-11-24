import { expect, test } from '@playwright/test'
import { account, addApple, dashboard, expectFitsScreen, futureDate, login, onboarding, register } from '../helpers'

for (const goal of ['Maintain', 'Gain', 'Lose'] as const) {
  test(goal + ': onboarding, plan, diary, reload and sign-in retain saved data', async ({ page, context }) => {
    const user = await register(page)
    await onboarding(page, goal)
    await page.getByRole('link', { name: 'Plan', exact: true }).click()
    await page.getByRole('button', { name: 'Create my plan' }).click()
    await expect(page.getByRole('heading', { name: 'Your daily plan.' })).toBeVisible()
    await page.getByRole('button', { name: 'Go to diary', exact: true }).click()
    await expect(page.getByRole('progressbar', { name: 'Daily calorie progress' })).toBeVisible()
    await addApple(page)
    const progress = page.getByRole('region', { name: 'Daily progress.' })
    await expect(progress).toContainText('95 kcal logged')
    await expect(progress).toContainText('Protein')
    const cookie = (await context.cookies()).find((item) => item.name === 'calorie_session')
    expect(cookie).toMatchObject({ httpOnly: true, sameSite: 'Lax', path: '/api' })
    await expectFitsScreen(page)
    await page.reload()
    await expect(progress).toContainText('95 kcal logged')
    await page.getByRole('link', { name: 'Plan', exact: true }).click()
    await expect(page.getByRole('heading', { name: 'Your daily plan.' })).toBeVisible()
    await page.getByRole('link', { name: 'Diary', exact: true }).click()
    await page.getByRole('button', { name: 'Log out', exact: true }).click()
    await expect(page.getByRole('heading', { name: 'Welcome back.' })).toBeVisible()
    const expired = await page.request.get('/api/auth/me')
    expect(expired.status()).toBe(401)
    await login(page, user)
    await expect(progress).toContainText('95 kcal logged')
    await expectFitsScreen(page)
  })
}

test('editing servings, moving dates and deleting update persisted totals', async ({ page }) => {
  await dashboard(page)
  await addApple(page)
  await page.getByRole('button', { name: 'Edit entry' }).click()
  await page.getByLabel('Entry servings', { exact: true }).fill('2')
  await expectFitsScreen(page)
  await page.getByRole('button', { name: 'Save changes' }).click()
  await expect(page.getByRole('region', { name: 'Daily progress.' })).toContainText('190 kcal logged')
  await page.getByRole('button', { name: 'Edit entry' }).click()
  await page.getByLabel('Entry date', { exact: true }).fill('2020-02-29')
  await page.getByRole('button', { name: 'Save changes' }).click()
  await expect(page.getByText('No food logged for this day yet.')).toBeVisible()
  await page.getByLabel('Diary date', { exact: true }).fill('2020-02-29')
  await expect(page.getByRole('region', { name: 'Daily progress.' })).toContainText('190 kcal logged')
  await page.reload()
  await page.getByLabel('Diary date', { exact: true }).fill('2020-02-29')
  await page.getByRole('button', { name: 'Delete entry' }).click()
  await expect(page.getByText('No food logged for this day yet.')).toBeVisible()
  await page.reload()
  await page.getByLabel('Diary date', { exact: true }).fill('2020-02-29')
  await expect(page.getByRole('region', { name: 'Daily progress.' })).toContainText('0 kcal logged')
})

test('real API ownership checks isolate two signed-in accounts', async ({ page, browser, baseURL }) => {
  await dashboard(page)
  await addApple(page)
  const date = await page.getByLabel('Diary date', { exact: true }).inputValue()
  const response = await page.request.get('/api/diary?date=' + date)
  const first = (await response.json()).entries[0]
  const other = await browser.newContext({ baseURL })
  try {
    const user = account()
    const result = await other.request.post('/api/auth/register', {
      data: user, headers: { Origin: baseURL!, 'X-CSRF-Protection': '1' },
    })
    expect(result.status()).toBe(201)
    const requests = [
      await other.request.get('/api/food/estimates/' + first.estimate.id),
      await other.request.put('/api/diary/entries/' + first.id, {
        data: { food_estimate_id: first.estimate.id, entry_date: date, servings: 2, version: first.version },
        headers: { Origin: baseURL!, 'X-CSRF-Protection': '1' },
      }),
      await other.request.delete('/api/diary/entries/' + first.id + '?version=' + first.version, {
        headers: { Origin: baseURL!, 'X-CSRF-Protection': '1' },
      }),
      await other.request.post('/api/diary/entries', {
        data: { id: crypto.randomUUID(), food_estimate_id: first.estimate.id, entry_date: date, servings: 1 },
        headers: { Origin: baseURL!, 'X-CSRF-Protection': '1' },
      }),
    ]
    for (const denied of requests) {
      expect(denied.status()).toBe(404)
      expect(denied.headers()['cache-control']).toBe('no-store')
    }
    expect((await (await other.request.get('/api/diary?date=' + date)).json()).entries).toEqual([])
    await page.getByRole('button', { name: 'Log out', exact: true }).click()
    await expect(page.getByRole('heading', { name: 'Welcome back.' })).toBeVisible()
    await login(page, user)
    await onboarding(page)
    await expect(page.getByText('No food logged for this day yet.')).toBeVisible()
    await expect(page.getByLabel('Food description', { exact: true })).toHaveValue('')
    await expect(page.getByRole('button', { name: 'Edit entry' })).toHaveCount(0)
  } finally {
    await other.close()
  }
})

test('recovering from a lost save reply does not duplicate the food', async ({ page }) => {
  await dashboard(page)
  const saves: unknown[] = []
  await page.route('**/api/diary/entries', async (route) => {
    saves.push(route.request().postDataJSON())
    if (saves.length === 1) {
      const saved = await route.fetch()
      expect(saved.status()).toBe(201)
      await route.abort('failed')
    } else await route.continue()
  })
  await page.getByLabel('Food description', { exact: true }).fill('apple')
  await page.getByRole('button', { name: 'Estimate nutrition' }).click()
  await page.getByRole('button', { name: 'Add to diary' }).click()
  await expect(page.getByRole('button', { name: 'Retry same save' })).toBeVisible()
  await page.getByRole('button', { name: 'Retry same save' }).click()
  await expect(page.getByRole('button', { name: 'Edit entry' })).toHaveCount(1)
  expect(saves).toHaveLength(2)
  expect(saves[0]).toEqual(saves[1])
  await page.reload()
  await expect(page.getByRole('region', { name: 'Daily progress.' })).toContainText('95 kcal logged')
})

test('warming HTML, transient errors and network loss recover through GET retries', async ({ page }) => {
  const user = await dashboard(page)
  let attempts = 0
  await page.route('**/api/auth/me', async (route) => {
    attempts += 1
    if (attempts === 1) await route.fulfill({ status: 200, contentType: 'text/html', body: '<html>Waking up</html>' })
    else if (attempts === 2) await route.fulfill({ status: 503, json: { detail: 'Starting' } })
    else await route.continue()
  })
  await page.reload()
  await expect(page.getByRole('heading', { name: 'Welcome, ' + user.username + '.' })).toBeVisible()
  expect(attempts).toBe(3)
  await page.unroute('**/api/auth/me')
  let reads = 0
  await page.route('**/api/diary?*', async (route) => {
    reads += 1
    if (reads === 1) await route.abort('failed')
    else await route.continue()
  })
  await page.getByRole('button', { name: 'Refresh diary' }).click()
  await expect(page.getByRole('button', { name: 'Refresh diary' })).toBeEnabled()
  await expect.poll(() => reads).toBe(2)
})

test('a slow cold-start read shows the waiting notice and then recovers', async ({ page }) => {
  await page.route('**/api/auth/me', async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 5500))
    await route.continue()
  })
  await page.goto('/')
  await expect(page.getByText(/taking a moment to wake up/i)).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Welcome back.' })).toBeVisible()
})

test('a persistent diary error preserves saved data and offers a working reload', async ({ page }) => {
  await dashboard(page)
  await addApple(page)
  await page.route('**/api/diary?*', (route) => route.fulfill({ status: 503, json: { detail: 'Unavailable' } }))
  await page.getByRole('button', { name: 'Refresh diary' }).click()
  await expect(page.getByRole('button', { name: 'Reload diary' })).toBeVisible()
  await page.unroute('**/api/diary?*')
  const recovered = page.waitForResponse((response) =>
    response.url().includes('/api/diary?') && response.status() === 200)
  await page.getByRole('button', { name: 'Reload diary' }).click()
  await recovered
  await expect(page.getByRole('button', { name: 'Refresh diary' })).toBeEnabled()
  await expect(page.getByRole('button', { name: 'Reload diary' })).toHaveCount(0)
  await expect(page.getByRole('region', { name: 'Daily progress.' })).toContainText('95 kcal logged')
})

for (const status of [422, 429]) {
  test('AI rejection ' + status + ' preserves the description for a successful retry', async ({ page }) => {
    await dashboard(page)
    await page.route('**/api/food/estimate', (route) => route.fulfill({ status, json: {} }))
    await page.getByLabel('Food description', { exact: true }).fill('apple')
    await page.getByRole('button', { name: 'Estimate nutrition' }).click()
    await expect(page.getByRole('alert')).toContainText(status === 422 ? 'identify' : 'quota')
    await expect(page.getByLabel('Food description', { exact: true })).toHaveValue('apple')
    await page.unroute('**/api/food/estimate')
    await page.getByRole('button', { name: 'Estimate nutrition' }).click()
    await page.getByRole('button', { name: 'Add to diary' }).click()
    await expect(page.getByRole('region', { name: 'Daily progress.' })).toContainText('95 kcal logged')
  })
}

test('session expiry during a diary write returns to login without retaining food', async ({ page }) => {
  await dashboard(page)
  await page.getByLabel('Food description', { exact: true }).fill('apple')
  await page.getByRole('button', { name: 'Estimate nutrition' }).click()
  await page.route('**/api/diary/entries', (route) => route.fulfill({ status: 401, json: {} }))
  await page.getByRole('button', { name: 'Add to diary' }).click()
  await expect(page.getByRole('heading', { name: 'Welcome back.' })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Medium apple' })).toHaveCount(0)
})

test('local midnight changes today, while a historical day stays selected', async ({ page }) => {
  // Install before loading React, so its existing interval is controlled too.
  await page.clock.install({ time: new Date('2026-01-01T10:00:00Z') })
  await dashboard(page)
  await expect(page.getByRole('link', { name: 'Diary', exact: true })).toHaveAttribute('aria-current', 'page')
  await page.clock.pauseAt(new Date('2026-01-01T10:59:50Z')) // Auckland: 23:59:50.
  await expect(page.getByLabel('Diary date', { exact: true })).toHaveValue('2026-01-01')
  await page.clock.fastForward(30_000)
  await expect(page.getByLabel('Diary date', { exact: true })).toHaveValue('2026-01-02')
  await page.getByLabel('Diary date', { exact: true }).fill('2020-02-29')
  await expect(page.getByRole('heading', { name: 'Food diary.', exact: true })).toBeVisible()
  await page.clock.fastForward(86_400_000)
  await expect(page.getByLabel('Diary date', { exact: true })).toHaveValue('2020-02-29')
  await page.getByRole('button', { name: 'Today', exact: true }).click()
  await expect(page.getByLabel('Diary date', { exact: true })).toHaveValue('2026-01-03')
})

test('dark mode and compact layouts keep the login, dashboard and editor within the viewport', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByRole('heading', { name: 'Welcome back.' })).toBeVisible()
  await expectFitsScreen(page)
  await page.getByRole('button', { name: 'Switch to dark mode' }).click()
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
  await dashboard(page)
  await addApple(page)
  await expectFitsScreen(page)
  await page.getByRole('button', { name: 'Edit entry' }).click()
  await expectFitsScreen(page)
  await page.reload()
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
  await page.getByRole('button', { name: 'Switch to light mode' }).click()
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')
})


test('separate pages preserve drafts and support direct links and browser history', async ({ page }) => {
  await dashboard(page)
  await page.getByLabel('Food description', { exact: true }).fill('two fried eggs with butter')
  await page.getByRole('link', { name: 'Profile', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Your profile is ready.' })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Food diary.' })).toBeHidden()
  await page.getByRole('button', { name: 'Edit profile', exact: true }).click()
  await page.getByRole('button', { name: /Continue/ }).click()
  await page.getByLabel('Weekly activity', { exact: true }).fill('New weekly routine draft')
  await expectFitsScreen(page)
  await page.getByRole('link', { name: 'Diary', exact: true }).click()
  await expect(page.getByLabel('Food description', { exact: true })).toHaveValue('two fried eggs with butter')
  await expect(page.getByLabel('Weekly activity', { exact: true })).toBeHidden()
  await page.goBack()
  await expect(page.getByLabel('Weekly activity', { exact: true })).toHaveValue('New weekly routine draft')
  await page.getByRole('button', { name: 'Cancel', exact: true }).click()
  await page.reload()
  await expect(page.getByRole('link', { name: 'Profile', exact: true })).toHaveAttribute('aria-current', 'page')
  await expect(page.getByRole('heading', { name: 'Your profile is ready.' })).toBeVisible()
  await expectFitsScreen(page)
})

test('diary controls stay with Food diary and align the current date beside the selector', async ({ page }) => {
  await dashboard(page)
  const diary = page.getByRole('region', { name: 'Food diary.', exact: true })
  const selector = diary.getByLabel('Diary date', { exact: true })
  const today = diary.locator('time')
  const initial = await selector.inputValue()
  await expect(today).toHaveAttribute('datetime', initial)
  await selector.fill('2020-02-29')
  await expect(selector).toBeFocused()
  await expect(today).toHaveAttribute('datetime', initial)
  await expectFitsScreen(page)
  const inputBox = await selector.boundingBox()
  const todayBox = await today.boundingBox()
  expect(inputBox).not.toBeNull()
  expect(todayBox).not.toBeNull()
  expect(Math.abs(inputBox!.y + inputBox!.height / 2 - todayBox!.y - todayBox!.height / 2)).toBeLessThanOrEqual(2)
  await diary.getByRole('button', { name: 'Today', exact: true }).click()
  await expect(selector).toHaveValue(initial)
})

test('two kilograms gain over four weeks saves a usable plan with pace advice', async ({ page }) => {
  await register(page)
  await onboarding(page, 'Gain')
  await page.getByRole('link', { name: 'Plan', exact: true }).click()
  await page.getByRole('button', { name: 'Create my plan', exact: true }).click()
  await page.getByRole('button', { name: 'Adjust goal', exact: true }).click()
  await expect(page.getByLabel('Target weight (kg)', { exact: true })).toBeVisible()
  await page.getByLabel('Target weight (kg)', { exact: true }).fill('77')
  await page.getByLabel('Target date', { exact: true }).fill(futureDate(28))
  await page.getByRole('button', { name: 'Save profile', exact: true }).click()
  await page.getByRole('button', { name: 'Create my plan', exact: true }).click()
  await expect(page.getByRole('note', { name: 'Ambitious pace' })).toBeVisible()
  const saved = await (await page.request.get('/api/plan')).json()
  expect(saved.targets.calorie_adjustment).toBe(550)
  expect(saved.weekly_change_kg).toBe(0.5)
  await expectFitsScreen(page)
})

test('a suggested date opens for review and only becomes saved after confirmation', async ({ page }) => {
  await register(page)
  await onboarding(page, 'Gain')
  await page.getByRole('link', { name: 'Profile', exact: true }).click()
  await page.getByRole('button', { name: 'Edit profile', exact: true }).click()
  await page.getByRole('button', { name: /Continue/ }).click()
  await page.getByRole('button', { name: /Continue/ }).click()
  await page.getByLabel('Target weight (kg)', { exact: true }).fill('77')
  await page.getByLabel('Target date', { exact: true }).fill(futureDate(7))
  await page.getByRole('button', { name: 'Save profile', exact: true }).click()
  await page.getByRole('button', { name: 'Create my plan', exact: true }).click()
  await page.getByRole('button', { name: 'Use suggested date', exact: true }).click()
  const suggested = await page.getByLabel('Target date', { exact: true }).inputValue()
  expect(suggested).toBe(futureDate(28))
  const before = await (await page.request.get('/api/profile')).json()
  expect(before.target_date).toBe(futureDate(7))
  await expectFitsScreen(page)
  await page.getByRole('button', { name: 'Save profile', exact: true }).click()
  await page.getByRole('button', { name: 'Create my plan', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Your daily plan.' })).toBeVisible()
})
