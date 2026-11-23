import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, expect, it, vi } from 'vitest'
import App from './App'
import { diaryDay } from './test/diaryFixtures'
import { FoodPanel } from './FoodPanel'
import type { FoodEstimate } from './foods'

const fetchMock = vi.fn<typeof fetch>()
const onSessionExpired = vi.fn()
const estimate: FoodEstimate = {
  id: 1, description: 'apple', model: 'openai/gpt-oss-20b', estimated_at: '2026-11-23T12:00:00Z',
  food: {
    name: 'Medium apple', serving_description: 'One medium raw apple, with skin.',
    estimated_weight_g: 182, calories: 95,
    protein_g: 0.5, carbohydrate_g: 25.1, fat_g: 0.3, fiber_g: 4.4,
    serving_assumptions: ['Assumed: one medium edible apple, about 182g.'],
    cooking_assumptions: ['Assumed: raw, with skin; no added fat.'],
  },
}

function json(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } })
}

function panel() {
  return render(<FoodPanel onSessionExpired={onSessionExpired} />)
}

async function submit(text = 'apple') {
  const user = userEvent.setup()
  await user.type(screen.getByLabelText('Food description'), text)
  await user.click(screen.getByRole('button', { name: 'Estimate nutrition' }))
  return user
}

beforeEach(() => {
  localStorage.clear()
  onSessionExpired.mockReset()
  fetchMock.mockReset().mockImplementation(async () => json(estimate, 201))
  vi.stubGlobal('fetch', fetchMock)
})

it('makes no automatic AI request when displaying the food form', () => {
  panel()
  expect(fetchMock).not.toHaveBeenCalled()
  expect(screen.getByLabelText('Food description')).toHaveAttribute('maxlength', '2000')
})

it('estimates the complete serving and shows all nutrients and assumptions', async () => {
  panel()
  await submit('  apple  ')
  const result = await screen.findByRole('region', { name: 'Medium apple' })
  expect(within(result).getByText(/95/)).toHaveTextContent('95 kcal for this serving')
  for (const label of ['Protein', 'Carbohydrates', 'Fat', 'Fiber'])
    expect(within(result).getByText(label)).toBeInTheDocument()
  expect(within(result).getByText(estimate.food.serving_assumptions[0])).toBeInTheDocument()
  expect(within(result).getByText(estimate.food.cooking_assumptions[0])).toBeInTheDocument()
  await waitFor(() => expect(screen.getByRole('heading', { name: 'Medium apple' })).toHaveFocus())
  expect(fetchMock).toHaveBeenCalledWith('/api/food/estimate', expect.objectContaining({
    method: 'POST', body: JSON.stringify({ description: 'apple' }), credentials: 'same-origin', cache: 'no-store',
    headers: { 'Content-Type': 'application/json', 'X-CSRF-Protection': '1' },
  }))
  expect(localStorage.length).toBe(0)
})

it.each([
  ['Apple', 'apple'], ['Fried egg', 'fried egg'],
  ['Eggs with butter', '2 fried eggs cooked with 1 tablespoon of butter'],
])('fills the %s example without spending quota', async (button, description) => {
  panel()
  await userEvent.setup().click(screen.getByRole('button', { name: button }))
  expect(screen.getByLabelText('Food description')).toHaveValue(description)
  expect(fetchMock).not.toHaveBeenCalled()
})

it.each(['', '   ', 'x'.repeat(2001)])('validates description length before requesting an estimate', async (text) => {
  panel()
  fireEvent.change(screen.getByLabelText('Food description'), { target: { value: text } })
  await userEvent.setup().click(screen.getByRole('button', { name: 'Estimate nutrition' }))
  expect(await screen.findByRole('alert')).toHaveTextContent('1–2,000 characters')
  expect(screen.getByLabelText('Food description')).toHaveFocus()
  expect(screen.getByLabelText('Food description')).toHaveAttribute('aria-invalid', 'true')
  expect(fetchMock).not.toHaveBeenCalled()
})

it('disables duplicate submissions and examples while estimating', async () => {
  let finish!: (value: Response) => void
  fetchMock.mockReturnValueOnce(new Promise((resolve) => { finish = resolve }))
  panel()
  await submit()
  expect(screen.getByRole('button', { name: 'Estimating…' })).toBeDisabled()
  expect(screen.getByLabelText('Food description')).toBeDisabled()
  expect(screen.getByRole('button', { name: 'Fried egg' })).toBeDisabled()
  expect(screen.getByRole('status')).toHaveTextContent('Estimating your food')
  await act(async () => { finish(json(estimate, 201)) })
  await screen.findByRole('heading', { name: 'Medium apple' })
  expect(fetchMock).toHaveBeenCalledTimes(1)
})

it('clears stale results when the description changes', async () => {
  panel()
  const user = await submit()
  await screen.findByRole('heading', { name: 'Medium apple' })
  await user.type(screen.getByLabelText('Food description'), ' with peanut butter')
  expect(screen.queryByRole('region', { name: 'Medium apple' })).not.toBeInTheDocument()
  expect(fetchMock).toHaveBeenCalledTimes(1)
})

it.each([
  [403, 'could not be verified'], [422, 'could not identify'], [429, 'AI quota'],
  [502, 'AI response'], [503, 'temporarily unavailable'], [504, 'took too long'],
  [500, 'Could not estimate'],
])('handles HTTP %s while keeping the description for a manual retry', async (status, message) => {
  fetchMock.mockResolvedValueOnce(json({}, status, { 'Retry-After': '45' }))
  panel()
  await submit()
  expect(await screen.findByRole('alert')).toHaveTextContent(message)
  expect(screen.getByLabelText('Food description')).toHaveValue('apple')
  expect(screen.getByRole('button', { name: 'Estimate nutrition' })).toBeEnabled()
  expect(fetchMock).toHaveBeenCalledTimes(1)
  if (status === 422) expect(screen.getByLabelText('Food description')).toHaveAttribute('aria-invalid', 'true')
  if (status === 429) expect(screen.getByRole('alert')).toHaveTextContent('45 seconds')
})

it.each(['bad', 'Infinity', '-1', '999999'])('ignores invalid quota retry durations: %s', async (duration) => {
  fetchMock.mockResolvedValueOnce(json({}, 429, { 'Retry-After': duration }))
  panel()
  await submit()
  expect(await screen.findByRole('alert')).not.toHaveTextContent('seconds')
})

it('returns to login when the session expires', async () => {
  fetchMock.mockResolvedValueOnce(json({}, 401))
  panel()
  await submit()
  await waitFor(() => expect(onSessionExpired).toHaveBeenCalledOnce())
})

it('preserves a valid zero-calorie water estimate', async () => {
  fetchMock.mockResolvedValueOnce(json({ ...estimate, food: {
    ...estimate.food, name: 'Water', calories: 0, protein_g: 0, carbohydrate_g: 0, fat_g: 0, fiber_g: 0,
  } }))
  panel()
  await submit('water')
  const result = await screen.findByRole('region', { name: 'Water' })
  expect(within(result).getByText('0', { selector: 'p' })).toHaveTextContent('0 kcal')
})

it.each([
  null, {}, { ...estimate, id: -1 }, { ...estimate, estimated_at: 'bad-date' },
  { ...estimate, food: null }, { ...estimate, food: { ...estimate.food, calories: '95' } },
  { ...estimate, food: { ...estimate.food, calories: 95.5 } },
  { ...estimate, food: { ...estimate.food, fat_g: -1 } },
  { ...estimate, food: { ...estimate.food, estimated_weight_g: 0 } },
  { ...estimate, food: { ...estimate.food, name: ' ' } },
  { ...estimate, food: { ...estimate.food, serving_assumptions: [] } },
  { ...estimate, food: { ...estimate.food, cooking_assumptions: [false] } },
])('rejects malformed food responses: %j', async (body) => {
  fetchMock.mockResolvedValueOnce(json(body))
  panel()
  await submit()
  expect(await screen.findByRole('alert')).toHaveTextContent('could not read the food estimate')
})

it('handles malformed JSON as a response validation error', async () => {
  fetchMock.mockResolvedValueOnce(new Response('invalid-json'))
  panel()
  await submit()
  expect(await screen.findByRole('alert')).toHaveTextContent('could not read the food estimate')
})

it.each([
  new TypeError('offline'),
  new DOMException('Exceeded deadline', 'TimeoutError'),
])('allows retry after a connection error or deadline', async (failure) => {
  fetchMock.mockRejectedValueOnce(failure)
  panel()
  const user = await submit()
  expect(await screen.findByRole('alert')).toBeInTheDocument()
  await user.click(screen.getByRole('button', { name: 'Estimate nutrition' }))
  await screen.findByRole('heading', { name: 'Medium apple' })
})

it('clears errors and invalid state when editing a rejected description', async () => {
  fetchMock.mockResolvedValueOnce(json({}, 422))
  panel()
  const user = await submit()
  await screen.findByRole('alert')
  await user.click(screen.getByRole('button', { name: 'Fried egg' }))
  expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  expect(screen.getByLabelText('Food description')).toHaveAttribute('aria-invalid', 'false')
})

it.each([false, true])('cancels pending estimates on unmount and ignores late results (rejected: %s)', async (reject) => {
  let finish!: (value: Response) => void
  let fail!: (error: Error) => void
  fetchMock.mockReturnValueOnce(new Promise((resolve, rejection) => { finish = resolve; fail = rejection }))
  const { unmount } = panel()
  await submit()
  await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
  const signal = fetchMock.mock.calls[0][1]?.signal
  expect(signal?.aborted).toBe(false)
  unmount()
  expect(signal?.aborted).toBe(true)
  await act(async () => { if (reject) fail(new Error('aborted')); else finish(json(estimate)) })
  expect(onSessionExpired).not.toHaveBeenCalled()
})

it('renders model text as text rather than interpreting markup', async () => {
  fetchMock.mockResolvedValueOnce(json({ ...estimate, food: { ...estimate.food, name: '<img src=x onerror=alert(1)>' } }))
  panel()
  await submit()
  expect(await screen.findByRole('heading', { name: '<img src=x onerror=alert(1)>' })).toBeInTheDocument()
  expect(document.querySelector('.food-result img')).toBeNull()
})

it('clears food results and drafts when another account signs in', async () => {
  const savedProfile = {
    goal: 'maintain', age: 30, height_cm: 175, current_weight_kg: 75, gender: 'female',
    activity_description: 'Office work and walking.', gym_sessions_per_week: 2, steps_per_day: 6000,
    target_weight_kg: null, target_date: null, created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z',
  }
  fetchMock.mockImplementation(async (url) => {
    if (url === '/api/auth/me') return json({ id: 1, username: 'Alice' })
    if (url === '/api/auth/login') return json({ id: 2, username: 'Bob' })
    if (url === '/api/auth/logout') return new Response(null, { status: 204 })
    if (String(url).startsWith('/api/diary?')) return json(diaryDay(new URL(String(url), 'http://local.test').searchParams.get('date')!))
    if (url === '/api/profile') return json(savedProfile)
    if (url === '/api/food/estimate') return json(estimate, 201)
    return json({}, 404)
  })
  vi.stubGlobal('matchMedia', vi.fn().mockReturnValue({ matches: false }))
  render(<App />)
  await screen.findByLabelText('Food description')
  const user = await submit()
  await screen.findByRole('heading', { name: 'Medium apple' })
  await user.click(screen.getByRole('button', { name: 'Log out' }))
  await screen.findByRole('heading', { name: 'Welcome back.' })
  await user.type(screen.getByLabelText('Username'), 'Bob')
  await user.type(screen.getByLabelText('Password'), 'sample password for testing')
  await user.click(screen.getByRole('button', { name: 'Log in to your account' }))
  await screen.findByRole('heading', { name: 'Welcome, Bob.' })
  expect(await screen.findByLabelText('Food description')).toHaveValue('')
  expect(screen.queryByRole('region', { name: 'Medium apple' })).not.toBeInTheDocument()
})
