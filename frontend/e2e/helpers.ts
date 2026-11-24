import { randomBytes } from 'node:crypto'
import { expect } from '@playwright/test'
import type { Page } from '@playwright/test'

export function account() {
  return { username: 'E2E' + randomBytes(10).toString('hex'), password: randomBytes(24).toString('base64url') }
}
export async function register(page: Page, user = account()) {
  await page.goto('/')
  await page.getByRole('button', { name: 'Sign up', exact: true }).click()
  await page.getByLabel('Username', { exact: true }).fill(user.username)
  await page.getByLabel('Password', { exact: true }).fill(user.password)
  await page.getByRole('button', { name: 'Create account', exact: true }).click()
  await expect(page.getByRole('radiogroup', { name: 'Weight goal' })).toBeVisible()
  return user
}
export async function login(page: Page, user: ReturnType<typeof account>) {
  await page.getByLabel('Username', { exact: true }).fill(user.username)
  await page.getByLabel('Password', { exact: true }).fill(user.password)
  await page.getByRole('button', { name: 'Log in to your account' }).click()
  await expect(page.getByRole('heading', { name: 'Welcome, ' + user.username + '.' })).toBeVisible()
}
export function futureDate(days = 150) {
  const value = new Date()
  value.setUTCDate(value.getUTCDate() + days)
  return value.toISOString().slice(0, 10)
}
export async function onboarding(page: Page, goal: 'Maintain' | 'Gain' | 'Lose' = 'Maintain') {
  await page.getByText(goal + ' weight', { exact: true }).click()
  await page.getByRole('button', { name: /Continue/ }).click()
  await page.getByLabel('Age (years)', { exact: true }).fill('30')
  await page.getByLabel('Height (cm)', { exact: true }).fill('175')
  await page.getByLabel('Current weight (kg)', { exact: true }).fill('75')
  await page.getByLabel('Gender', { exact: true }).selectOption('female')
  await page.getByLabel('Weekly activity', { exact: true }).fill('Office work, gym twice weekly and evening walks.')
  await page.getByLabel('Gym sessions per week', { exact: true }).fill('2')
  await page.getByLabel('Average daily steps', { exact: true }).fill('6000')
  if (goal !== 'Maintain') {
    await page.getByRole('button', { name: /Continue/ }).click()
    await page.getByLabel('Target weight (kg)', { exact: true }).fill(goal === 'Gain' ? '80' : '70')
    await page.getByLabel('Target date', { exact: true }).fill(futureDate())
    await expectFitsScreen(page)
  }
  await page.getByRole('button', { name: /Save/ }).click()
  await expect(page.getByRole('heading', { name: 'Your profile is ready.' })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Food diary.' })).toBeVisible()
}
export async function dashboard(page: Page) {
  const user = await register(page)
  await onboarding(page)
  return user
}
export async function addApple(page: Page) {
  await page.getByLabel('Food description', { exact: true }).fill('apple')
  await page.getByRole('button', { name: 'Estimate nutrition' }).click()
  await page.getByRole('button', { name: 'Add to diary' }).click()
  await expect(page.getByRole('button', { name: 'Edit entry' })).toBeVisible()
}
export async function expectFitsScreen(page: Page) {
  await expect.poll(() => page.evaluate(() => {
    const width = document.documentElement.clientWidth
    const controls = [...document.querySelectorAll('input, select, textarea, button, progress')]
      .filter((node) => node.getClientRects().length > 0)
    return document.documentElement.scrollWidth <= width + 1 && controls.every((node) => {
      const box = node.getBoundingClientRect()
      return box.left >= -1 && box.right <= width + 1
    })
  })).toBe(true)
}
