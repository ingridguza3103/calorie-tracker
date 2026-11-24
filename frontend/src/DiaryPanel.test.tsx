import { stubApiFetch } from './test/mockApiFetch'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import App from './App'
import { beforeEach, expect, it, vi } from 'vitest'
import { DiaryWorkspace } from './DiaryPanel'
import type { DiaryEntry } from './diary'
import { localDay } from './diaryDate'
import { apple, diaryDay, entry, json, targets } from './test/diaryFixtures'

const fetchMock = vi.fn<typeof fetch>()
const onSessionExpired = vi.fn()
let entries: DiaryEntry[]
let withTargets: boolean
let foodId: number
let date: string
beforeEach(() => {
  entries = []
  withTargets = true
  foodId = 1
  date = localDay()
  onSessionExpired.mockReset()
  localStorage.clear()
  fetchMock.mockReset().mockImplementation(async (url, options) => {
    const path = String(url)
    if (path.startsWith('/api/diary?')) {
      const selected = new URL(path, 'http://local.test').searchParams.get('date')!
      return json(diaryDay(selected, entries.filter((item) => item.entry_date === selected), withTargets))
    }
    if (path === '/api/food/estimate') return json({ ...apple, id: foodId }, 201)
    if (path === '/api/diary/entries') {
      const value = JSON.parse(String(options?.body))
      const found = entries.find((item) => item.id === value.id)
      const saved = found ?? entry(value.entry_date, { id: value.id, servings: value.servings,
        totals: { calories: Math.round(95 * value.servings), protein_g: 0.5, carbohydrate_g: 25.1, fat_g: 0.3, fiber_g: 4.4 } })
      if (!found) entries.push(saved)
      return json(saved, found ? 200 : 201)
    }
    if (options?.method === 'PUT') {
      const value = JSON.parse(String(options.body))
      const saved = entry(value.entry_date, { id: path.split('/').at(-1)!, servings: value.servings, version: value.version + 1,
        estimate: { ...apple, id: value.food_estimate_id }, totals: { ...apple.food, calories: 95 * value.servings } })
      entries = entries.map((item) => item.id === saved.id ? saved : item)
      return json(saved)
    }
    if (options?.method === 'DELETE') {
      entries = entries.filter((item) => item.id !== path.split('/').at(-1)!.split('?')[0])
      return new Response(null, { status: 204 })
    }
    return json({}, 404)
  })
  stubApiFetch(fetchMock)
})
function panel() { return render(<DiaryWorkspace revision={0} onSessionExpired={onSessionExpired} />) }
async function ready() { return screen.findByRole('heading', { name: 'Food diary.' }) }
async function estimate() {
  fireEvent.change(screen.getByLabelText('Food description'), { target: { value: 'apple' } })
  await userEvent.setup().click(screen.getByRole('button', { name: 'Estimate nutrition' }))
  await screen.findByRole('button', { name: 'Add to diary' })
}
function posts() { return fetchMock.mock.calls.filter(([url, options]) => url === '/api/diary/entries' && options?.method === 'POST') }
function edits() { return fetchMock.mock.calls.filter(([, options]) => options?.method === 'PUT') }
function aiCalls() { return fetchMock.mock.calls.filter(([url]) => url === '/api/food/estimate') }
function row() { return screen.getByRole('listitem', { name: 'Medium apple' }) }
async function edit() {
  await userEvent.setup().click(within(row()).getByRole('button', { name: 'Edit entry' }))
}
function change(label: string, value: string) { fireEvent.change(screen.getByLabelText(label), { target: { value } }) }
function pending<T>() {
  let finish!: (value: T) => void
  let fail!: (reason: unknown) => void
  const promise = new Promise<T>((resolve, reject) => { finish = resolve; fail = reject })
  return { promise, finish, fail }
}

it('opens the browser local day without making an AI request and shows current targets', async () => {
  panel()
  await ready()
  expect(screen.getByLabelText('Diary date')).toHaveValue(date)
  expect(fetchMock).toHaveBeenCalledWith('/api/diary?date=' + date, expect.anything())
  expect(screen.getByRole('progressbar', { name: 'Daily calorie progress' })).toHaveAttribute('value', '0')
  expect(screen.getByText(/0% of your current daily target/)).toBeInTheDocument()
  expect(screen.getByText(/2,000 kcal remaining/)).toBeInTheDocument()
  expect(screen.getByText('No food logged for this day yet.')).toBeInTheDocument()
  for (const name of ['Protein', 'Carbohydrates', 'Fat', 'Fiber']) {
    expect(screen.getByRole('progressbar', { name: name + ' progress' })).toHaveAttribute('value', '0')
  }
  expect(aiCalls()).toHaveLength(0)
  expect(localStorage.length).toBe(0)
})
it('shows consumed totals above target with a capped progress bar and full percentage', async () => {
  entries = [entry(date, { servings: 20, totals: { calories: 2400, protein_g: 200, carbohydrate_g: 300, fat_g: 90, fiber_g: 40 } })]
  panel()
  await ready()
  expect(screen.getByRole('progressbar', { name: 'Daily calorie progress' })).toHaveAttribute('value', '2000')
  for (const [name, target] of [['Protein', '120'], ['Carbohydrates', '230'], ['Fat', '67'], ['Fiber', '28']]) {
    expect(screen.getByRole('progressbar', { name: name + ' progress' })).toHaveAttribute('value', target)
  }
  expect(screen.getByText(/120% of your current daily target/)).toBeInTheDocument()
  expect(screen.getByText('400 kcal above your current target.')).toBeInTheDocument()
  expect(screen.queryByText('1 × the described serving')).not.toBeInTheDocument()
  const details = within(row()).getByText('Serving and cooking assumptions')
  await userEvent.setup().click(details)
  expect(within(row()).getByText(apple.food.cooking_assumptions[0])).toBeInTheDocument()
})
it('allows diary logging without a calorie plan', async () => {
  withTargets = false
  panel()
  await ready()
  expect(screen.queryByRole('progressbar', { name: 'Daily calorie progress' })).not.toBeInTheDocument()
  expect(screen.getByText(/Create a current calorie plan/)).toBeInTheDocument()
  await estimate()
  await userEvent.setup().click(screen.getByRole('button', { name: 'Add to diary' }))
  await screen.findByRole('button', { name: 'Edit entry' })
})
it('saves the selected serving amount, refreshes totals, and deliberately adds the same food twice', async () => {
  panel()
  await ready()
  await estimate()
  change('Servings to log', '2')
  const user = userEvent.setup()
  await user.click(screen.getByRole('button', { name: 'Add to diary' }))
  await screen.findByRole('button', { name: 'Edit entry' })
  expect(JSON.parse(String(posts()[0][1]?.body))).toMatchObject({ entry_date: date, servings: 2, food_estimate_id: 1 })
  expect(screen.getByText('190 kcal')).toBeInTheDocument()
  await user.click(screen.getByRole('button', { name: 'Add again' }))
  await user.click(screen.getByRole('button', { name: 'Add to diary' }))
  await waitFor(() => expect(screen.getAllByRole('button', { name: 'Edit entry' })).toHaveLength(2))
  expect(JSON.parse(String(posts()[0][1]?.body)).id).not.toBe(JSON.parse(String(posts()[1][1]?.body)).id)
  expect(aiCalls()).toHaveLength(1)
})
it.each(['0', '21', '0.001', ''])('rejects servings %s before any save', async (value) => {
  panel()
  await ready()
  await estimate()
  change('Servings to log', value)
  await userEvent.setup().click(screen.getByRole('button', { name: 'Add to diary' }))
  expect(await screen.findByRole('alert')).toHaveTextContent('0.01–20')
  expect(screen.getByLabelText('Servings to log')).toHaveFocus()
  expect(posts()).toHaveLength(0)
})
it('retries an uncertain save with the identical UUID and payload while locking the draft', async () => {
  const original = fetchMock.getMockImplementation()!
  let first = true
  fetchMock.mockImplementation(async (url, options) => {
    if (url === '/api/diary/entries' && first) {
      first = false
      await original(url, options) // Server persisted it but the reply was lost.
      throw new TypeError('lost reply')
    }
    return original(url, options)
  })
  panel()
  await ready()
  await estimate()
  const user = userEvent.setup()
  await user.click(screen.getByRole('button', { name: 'Add to diary' }))
  await screen.findByRole('button', { name: 'Retry same save' })
  expect(screen.getByLabelText('Servings to log')).toBeDisabled()
  expect(screen.getByLabelText('Food description')).toBeDisabled()
  await user.click(screen.getByRole('button', { name: 'Retry same save' }))
  await screen.findByRole('button', { name: 'Edit entry' })
  expect(posts()[0][1]?.body).toBe(posts()[1][1]?.body)
  expect(entries).toHaveLength(1)
  expect(screen.getByLabelText('Food description')).toBeEnabled()
})
it('retains an ambiguous HTTP 500 save for retry', async () => {
  const original = fetchMock.getMockImplementation()!
  fetchMock.mockImplementation((url, options) => url === '/api/diary/entries' ? Promise.resolve(json({}, 500)) : original(url, options))
  panel()
  await ready()
  await estimate()
  await userEvent.setup().click(screen.getByRole('button', { name: 'Add to diary' }))
  expect(await screen.findByRole('button', { name: 'Retry same save' })).toBeEnabled()
  expect(posts()).toHaveLength(1)
})
it.each([403, 409, 422])('unlocks the add form after a definite HTTP %s rejection', async (status) => {
  const original = fetchMock.getMockImplementation()!
  fetchMock.mockImplementation((url, options) => url === '/api/diary/entries' ? Promise.resolve(json({}, status)) : original(url, options))
  panel()
  await ready()
  await estimate()
  await userEvent.setup().click(screen.getByRole('button', { name: 'Add to diary' }))
  await screen.findByRole('alert')
  expect(screen.getByLabelText('Servings to log')).toBeEnabled()
  expect(screen.getByLabelText('Food description')).toBeEnabled()
})
it('expires the session on a failed add', async () => {
  const original = fetchMock.getMockImplementation()!
  fetchMock.mockImplementation((url, options) => url === '/api/diary/entries' ? Promise.resolve(json({}, 401)) : original(url, options))
  panel()
  await ready()
  await estimate()
  await userEvent.setup().click(screen.getByRole('button', { name: 'Add to diary' }))
  expect(onSessionExpired).toHaveBeenCalledOnce()
})
it('disables duplicate saves and aborts a pending add when the day changes', async () => {
  const waiting = pending<Response>()
  const original = fetchMock.getMockImplementation()!
  fetchMock.mockImplementation((url, options) => url === '/api/diary/entries' ? waiting.promise : original(url, options))
  panel()
  await ready()
  await estimate()
  await userEvent.setup().click(screen.getByRole('button', { name: 'Add to diary' }))
  expect(screen.getByRole('button', { name: 'Saving entry…' })).toBeDisabled()
  const signal = posts()[0][1]?.signal
  change('Diary date', '2026-01-01')
  await ready()
  expect(signal?.aborted).toBe(true)
  await act(async () => waiting.finish(json(entry(date))))
  expect(screen.queryByText(/Added to/)).not.toBeInTheDocument()
  expect(screen.getByLabelText('Food description')).toHaveValue('')
})
it('edits the amount without Groq, updates totals, then deletes the entry', async () => {
  entries = [entry(date)]
  panel()
  await ready()
  const user = userEvent.setup()
  await edit()
  change('Entry servings', '2')
  await user.click(screen.getByRole('button', { name: 'Save changes' }))
  await waitFor(() => expect(screen.getByText('190 kcal')).toBeInTheDocument())
  expect(JSON.parse(String(edits()[0][1]?.body))).toMatchObject({ servings: 2, version: 1, food_estimate_id: 1 })
  expect(aiCalls()).toHaveLength(0)
  await user.click(screen.getByRole('button', { name: 'Delete entry' }))
  await screen.findByText('No food logged for this day yet.')
  expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith('?version=2'))).toBe(true)
})
it('moves entries to another day without another AI estimate', async () => {
  entries = [entry(date)]
  panel()
  await ready()
  await edit()
  change('Entry date', '2020-02-29')
  await userEvent.setup().click(screen.getByRole('button', { name: 'Save changes' }))
  await screen.findByText('No food logged for this day yet.')
  change('Diary date', '2020-02-29')
  await screen.findByRole('button', { name: 'Edit entry' })
  expect(aiCalls()).toHaveLength(0)
  await userEvent.setup().click(screen.getByRole('button', { name: 'Today' }))
  await screen.findByText('No food logged for this day yet.')
  expect(screen.getByLabelText('Diary date')).toHaveValue(date)
})
it('re-estimates a changed description and saves the new food reference', async () => {
  entries = [entry(date)]
  foodId = 2
  panel()
  await ready()
  await edit()
  change('Edit food description', '2 fried eggs with butter')
  await userEvent.setup().click(screen.getByRole('button', { name: 'Save changes' }))
  await waitFor(() => expect(screen.queryByRole('button', { name: 'Save changes' })).not.toBeInTheDocument())
  expect(aiCalls()[0][1]?.body).toBe(JSON.stringify({ description: '2 fried eggs with butter' }))
  expect(JSON.parse(String(edits()[0][1]?.body)).food_estimate_id).toBe(2)
})
it('cancels edits and restores the saved description and serving', async () => {
  entries = [entry(date)]
  panel()
  await ready()
  await edit()
  change('Entry servings', '3')
  change('Edit food description', 'wrong draft')
  await userEvent.setup().click(screen.getByRole('button', { name: 'Cancel editing' }))
  await edit()
  expect(screen.getByLabelText('Edit food description')).toHaveValue('apple')
  expect(screen.getByLabelText('Entry servings')).toHaveValue(1)
  expect(edits()).toHaveLength(0)
})
it.each([['Entry servings', '0'], ['Edit food description', ''], ['Entry date', '']])('validates edits to %s', async (label, value) => {
  entries = [entry(date)]
  panel()
  await ready()
  await edit()
  change(label, value)
  await userEvent.setup().click(screen.getByRole('button', { name: 'Save changes' }))
  expect(await screen.findByRole('alert')).toHaveTextContent('valid date')
  expect(edits()).toHaveLength(0)
})
it('retries an uncertain edit with the same payload and without re-estimating', async () => {
  entries = [entry(date)]
  const original = fetchMock.getMockImplementation()!
  let first = true
  fetchMock.mockImplementation(async (url, options) => {
    if (options?.method === 'PUT' && first) { first = false; throw new TypeError('lost reply') }
    return original(url, options)
  })
  panel()
  await ready()
  await edit()
  change('Entry servings', '2')
  const user = userEvent.setup()
  await user.click(screen.getByRole('button', { name: 'Save changes' }))
  await screen.findByRole('button', { name: 'Retry changes' })
  expect(screen.getByLabelText('Entry servings')).toBeDisabled()
  await user.click(screen.getByRole('button', { name: 'Retry changes' }))
  await waitFor(() => expect(screen.getByText('190 kcal')).toBeInTheDocument())
  expect(edits()[0][1]?.body).toBe(edits()[1][1]?.body)
  expect(aiCalls()).toHaveLength(0)
})
it.each(['PUT', 'DELETE'])('reloads after a stale %s conflict', async (method) => {
  entries = [entry(date)]
  const original = fetchMock.getMockImplementation()!
  fetchMock.mockImplementation((url, options) => options?.method === method ? Promise.resolve(json({}, 409)) : original(url, options))
  panel()
  await ready()
  if (method === 'PUT') {
    await edit()
    change('Entry servings', '2')
    await userEvent.setup().click(screen.getByRole('button', { name: 'Save changes' }))
  } else await userEvent.setup().click(screen.getByRole('button', { name: 'Delete entry' }))
  await screen.findByRole('button', { name: 'Reload diary' })
  entries = [entry(date, { version: 2, servings: 3 })]
  await userEvent.setup().click(screen.getByRole('button', { name: 'Reload diary' }))
  await screen.findByText('3 × the described serving')
})
it.each(['PUT', 'DELETE'])('expires a session on %s', async (method) => {
  entries = [entry(date)]
  const original = fetchMock.getMockImplementation()!
  fetchMock.mockImplementation((url, options) => options?.method === method ? Promise.resolve(json({}, 401)) : original(url, options))
  panel()
  await ready()
  if (method === 'PUT') {
    await edit()
    change('Entry servings', '2')
    await userEvent.setup().click(screen.getByRole('button', { name: 'Save changes' }))
  } else await userEvent.setup().click(screen.getByRole('button', { name: 'Delete entry' }))
  await waitFor(() => expect(onSessionExpired).toHaveBeenCalledOnce())
})
it('keeps a changed description when Groq fails and does not update the diary', async () => {
  entries = [entry(date)]
  const original = fetchMock.getMockImplementation()!
  fetchMock.mockImplementation((url, options) => url === '/api/food/estimate' ? Promise.resolve(json({}, 429)) : original(url, options))
  panel()
  await ready()
  await edit()
  change('Edit food description', 'fried egg')
  await userEvent.setup().click(screen.getByRole('button', { name: 'Save changes' }))
  expect(await screen.findByRole('alert')).toHaveTextContent('quota')
  expect(screen.getByLabelText('Edit food description')).toHaveValue('fried egg')
  expect(edits()).toHaveLength(0)
})
it('shows a recoverable diary read failure and reloads it', async () => {
  const original = fetchMock.getMockImplementation()!
  let failed = true
  fetchMock.mockImplementation((url, options) => String(url).startsWith('/api/diary?') && failed
    ? Promise.resolve(json({}, 403)) : original(url, options))
  panel()
  await screen.findByRole('button', { name: 'Reload diary' })
  failed = false
  await userEvent.setup().click(screen.getByRole('button', { name: 'Reload diary' }))
  await ready()
  await userEvent.setup().click(screen.getByRole('button', { name: 'Refresh diary' }))
  await waitFor(() => expect(fetchMock.mock.calls.filter(([url]) => String(url).startsWith('/api/diary?'))).toHaveLength(3))
})
it('expires the session on diary load', async () => {
  fetchMock.mockResolvedValue(json({}, 401))
  panel()
  await waitFor(() => expect(onSessionExpired).toHaveBeenCalledOnce())
})
it.each([false, true])('aborts old day reads and ignores late replies (rejected: %s)', async (reject) => {
  const waiting = pending<Response>()
  const original = fetchMock.getMockImplementation()!
  fetchMock.mockImplementationOnce(() => waiting.promise).mockImplementation(original)
  panel()
  await waitFor(() => expect(fetchMock).toHaveBeenCalled())
  const signal = fetchMock.mock.calls[0][1]?.signal
  change('Diary date', '2020-01-01')
  await ready()
  expect(signal?.aborted).toBe(true)
  await act(async () => {
    if (reject) waiting.fail(new Error('late error'))
    else waiting.finish(json(diaryDay(date, [entry(date)])))
  })
  expect(screen.queryByRole('button', { name: 'Edit entry' })).not.toBeInTheDocument()
  expect(onSessionExpired).not.toHaveBeenCalled()
})
it.each(['PUT', 'DELETE', 'AI'])('aborts a pending %s when leaving the diary', async (method) => {
  entries = [entry(date)]
  const waiting = pending<Response>()
  const original = fetchMock.getMockImplementation()!
  fetchMock.mockImplementation((url, options) => (method === 'AI' ? url === '/api/food/estimate' : options?.method === method)
    ? waiting.promise : original(url, options))
  const view = panel()
  await ready()
  if (method === 'DELETE') await userEvent.setup().click(screen.getByRole('button', { name: 'Delete entry' }))
  else {
    await edit()
    change(method === 'AI' ? 'Edit food description' : 'Entry servings', method === 'AI' ? 'egg' : '2')
    await userEvent.setup().click(screen.getByRole('button', { name: 'Save changes' }))
  }
  const call = fetchMock.mock.calls.at(-1)!
  expect(call[1]?.signal?.aborted).toBe(false)
  view.unmount()
  expect(call[1]?.signal?.aborted).toBe(true)
  await act(async () => waiting.finish(json(method === 'AI' ? apple : entry(date))))
  expect(onSessionExpired).not.toHaveBeenCalled()
})
it('refreshes targets when a plan is created', async () => {
  withTargets = false
  const view = panel()
  await ready()
  expect(screen.queryByRole('progressbar', { name: 'Daily calorie progress' })).not.toBeInTheDocument()
  withTargets = true
  view.rerender(<DiaryWorkspace revision={1} onSessionExpired={onSessionExpired} />)
  await screen.findByRole('progressbar', { name: 'Daily calorie progress' })
})

const savedProfile = {
  goal: 'maintain', age: 30, height_cm: 175, current_weight_kg: 75, gender: 'female',
  activity_description: 'Office work and walking.', gym_sessions_per_week: 2, steps_per_day: 6000,
  target_weight_kg: null, target_date: null, created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z',
}
function authenticatedApp() {
  const original = fetchMock.getMockImplementation()!
  fetchMock.mockImplementation(async (url, options) => {
    if (url === '/api/auth/me') return json({ id: 1, username: 'Alice' })
    if (url === '/api/auth/logout') return new Response(null, { status: 204 })
    if (url === '/api/auth/login') {
      entries = []
      return json({ id: 2, username: 'Bob' })
    }
    if (url === '/api/profile') return json(savedProfile)
    if (url === '/api/plan') {
      if (options?.method !== 'POST') return json({}, 404)
      withTargets = true
      return json({
        version: 1, goal: 'maintain', current_weight_kg: 75, target_weight_kg: null, target_date: null,
        timeline_days: null, weekly_change_kg: 0, assumptions: [],
        maintenance: { maintenance_calories: 2000, activity: { summary: 'Walking.', assumptions: [] }, assumptions: [] },
        targets,
      }, 201)
    }
    return original(url, options)
  })
  vi.stubGlobal('matchMedia', vi.fn().mockReturnValue({ matches: false }))
  return render(<App />)
}
it('updates diary targets after creating a plan in the signed-in dashboard', async () => {
  withTargets = false
  authenticatedApp()
  await ready()
  expect(screen.queryByRole('progressbar', { name: 'Daily calorie progress' })).not.toBeInTheDocument()
  const user = userEvent.setup()
  await user.click(await screen.findByRole('link', { name: 'Plan' }))
  await user.click(await screen.findByRole('button', { name: 'Create my plan' }))
  await screen.findByRole('heading', { name: 'Your daily plan.' })
  await user.click(screen.getByRole('button', { name: 'Go to diary' }))
  await screen.findByRole('progressbar', { name: 'Daily calorie progress' })
  expect(fetchMock.mock.calls.filter(([url]) => String(url).startsWith('/api/diary?'))).toHaveLength(2)
})
it('discards the previous account diary and unsaved editor on logout', async () => {
  entries = [entry(date)]
  authenticatedApp()
  await ready()
  await edit()
  change('Edit food description', 'private draft')
  const user = userEvent.setup()
  await user.click(screen.getByRole('button', { name: 'Log out' }))
  await screen.findByRole('heading', { name: 'Welcome back.' })
  expect(screen.queryByDisplayValue('private draft')).not.toBeInTheDocument()
  await user.type(screen.getByLabelText('Username'), 'Bob')
  await user.type(screen.getByLabelText('Password'), 'sample password for testing')
  await user.click(screen.getByRole('button', { name: 'Log in to your account' }))
  await screen.findByRole('heading', { name: 'Welcome, Bob.' })
  await ready()
  expect(screen.getByText('No food logged for this day yet.')).toBeInTheDocument()
  expect(screen.queryByRole('button', { name: 'Edit entry' })).not.toBeInTheDocument()
  expect(screen.getByLabelText('Food description')).toHaveValue('')
})
