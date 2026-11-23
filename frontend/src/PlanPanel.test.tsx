import { act, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, expect, it, vi } from 'vitest'
import { PlanPanel } from './PlanPanel'
import type { CaloriePlan } from './plans'
import type { Profile } from './profiles'

const fetchMock = vi.fn<typeof fetch>()
const onEdit = vi.fn()
const onSessionExpired = vi.fn()
const profile: Profile = {
  goal: 'maintain', age: 30, height_cm: 175, current_weight_kg: 75, gender: 'female',
  activity_description: 'Office work and gym.', gym_sessions_per_week: 2, steps_per_day: 6000,
  target_weight_kg: null, target_date: null,
  created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z',
}

function plan(goal: CaloriePlan['goal'] = 'maintain'): CaloriePlan {
  const target = new Date()
  target.setUTCDate(target.getUTCDate() + 150)
  return {
    version: 1, goal, current_weight_kg: 75,
    target_weight_kg: goal === 'maintain' ? null : goal === 'lose' ? 70 : 80,
    target_date: goal === 'maintain' ? null : target.toISOString().slice(0, 10),
    timeline_days: goal === 'maintain' ? null : 150,
    weekly_change_kg: goal === 'maintain' ? 0 : goal === 'lose' ? -0.182 : 0.182,
    maintenance: {
      maintenance_calories: 2000,
      activity: { summary: 'Regular walking and gym.', assumptions: ['No duration supplied.'] },
      assumptions: ['Activity is approximate.'],
    },
    targets: {
      daily_calories: goal === 'maintain' ? 2000 : goal === 'lose' ? 1800 : 2200,
      calorie_adjustment: goal === 'maintain' ? 0 : goal === 'lose' ? -200 : 200,
      protein_g: 120, carbohydrate_g: 230, fat_g: 66.7, fiber_g: 28,
    },
    assumptions: ['These are starting estimates.'],
  }
}

function json(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } })
}

function panel() {
  return render(<PlanPanel profile={profile} onEdit={onEdit} onSessionExpired={onSessionExpired} />)
}

beforeEach(() => {
  fetchMock.mockReset().mockResolvedValue(json({}, 404))
  onEdit.mockReset()
  onSessionExpired.mockReset()
  vi.stubGlobal('fetch', fetchMock)
})

it('loads saved targets without asking Groq to generate another plan', async () => {
  fetchMock.mockResolvedValue(json(plan()))
  panel()
  const result = await screen.findByRole('region', { name: 'Your daily plan.' })
  expect(within(result).getByText('2,000')).toBeInTheDocument()
  expect(within(result).getByText('Protein')).toBeInTheDocument()
  expect(within(result).getByText('Carbohydrates')).toBeInTheDocument()
  expect(within(result).getByText('Fat')).toBeInTheDocument()
  expect(within(result).getByText('Fiber')).toBeInTheDocument()
  expect(screen.getByRole('heading', { name: 'Your daily plan.' })).toHaveFocus()
  await userEvent.setup().click(screen.getByText('How this was estimated'))
  expect(screen.getByText('Regular walking and gym.')).toBeVisible()
  expect(screen.getByText('No duration supplied.')).toBeVisible()
  expect(fetchMock).toHaveBeenCalledTimes(1)
  expect(fetchMock).toHaveBeenCalledWith('/api/plan', expect.objectContaining({ credentials: 'same-origin' }))
})

it.each(['maintain', 'gain', 'lose'] as const)('creates a %s plan with an explicit protected request', async (goal) => {
  panel()
  const button = await screen.findByRole('button', { name: 'Create my plan' })
  expect(fetchMock).toHaveBeenCalledTimes(1)
  fetchMock.mockResolvedValueOnce(json(plan(goal), 201))
  await userEvent.setup().click(button)
  await screen.findByRole('heading', { name: 'Your daily plan.' })
  expect(fetchMock.mock.calls[1]).toEqual(['/api/plan', expect.objectContaining({
    method: 'POST', body: '{}', credentials: 'same-origin', cache: 'no-store',
    headers: { 'Content-Type': 'application/json', 'X-CSRF-Protection': '1' },
  })])
  if (goal === 'maintain') expect(screen.queryByText(/Working toward/)).not.toBeInTheDocument()
  else expect(screen.getByText(/Working toward/)).toHaveTextContent('kg per week')
})

it('disables duplicate requests while a plan is being created', async () => {
  panel()
  await screen.findByRole('button', { name: 'Create my plan' })
  let finish!: (response: Response) => void
  fetchMock.mockReturnValueOnce(new Promise((resolve) => { finish = resolve }))
  await userEvent.setup().click(screen.getByRole('button', { name: 'Create my plan' }))
  expect(screen.getByRole('button', { name: 'Creating plan…' })).toBeDisabled()
  expect(screen.getByRole('status')).toHaveTextContent('Building your plan')
  await act(async () => { finish(json(plan(), 201)) })
  await screen.findByRole('heading', { name: 'Your daily plan.' })
  expect(fetchMock.mock.calls.filter(([, options]) => options?.method === 'POST')).toHaveLength(1)
})

it('explains an infeasible goal, suggests a date, and opens profile editing', async () => {
  panel()
  await screen.findByRole('button', { name: 'Create my plan' })
  fetchMock.mockResolvedValueOnce(json({ detail: {
    code: 'timeline_too_short', message: 'This goal needs more time.',
    suggested_target_date: '2027-04-15', field: 'target_date',
  } }, 422))
  const user = userEvent.setup()
  await user.click(screen.getByRole('button', { name: 'Create my plan' }))
  expect(await screen.findByRole('alert')).toHaveTextContent('This goal needs more time.')
  expect(screen.getByText(/Suggested earliest date/)).toBeInTheDocument()
  await user.click(screen.getByRole('button', { name: 'Adjust goal' }))
  expect(onEdit).toHaveBeenCalledTimes(1)
})

it.each([null, 'not-a-date', '2027-02-31'])('handles a blocked goal without a valid suggested date: %j', async (suggestion) => {
  panel()
  await screen.findByRole('button', { name: 'Create my plan' })
  fetchMock.mockResolvedValueOnce(json({ detail: { message: 'Review this goal.', suggested_target_date: suggestion } }, 422))
  await userEvent.setup().click(screen.getByRole('button', { name: 'Create my plan' }))
  expect(await screen.findByRole('alert')).toHaveTextContent('Review this goal.')
  expect(screen.queryByText(/Suggested earliest date/)).not.toBeInTheDocument()
})

it.each([
  [403, 'could not be verified'],
  [409, 'profile changed'],
  [422, 'Review your profile'],
  [429, 'AI quota'],
  [502, 'AI response'],
  [503, 'temporarily unavailable'],
  [504, 'took too long'],
  [500, 'Could not load or create'],
])('shows an actionable error for HTTP %s without automatic provider retries', async (status, message) => {
  panel()
  await screen.findByRole('button', { name: 'Create my plan' })
  fetchMock.mockResolvedValueOnce(json({}, status, { 'Retry-After': '65' }))
  await userEvent.setup().click(screen.getByRole('button', { name: 'Create my plan' }))
  expect(await screen.findByRole('alert')).toHaveTextContent(message)
  if (status === 429) expect(screen.getByRole('alert')).toHaveTextContent('65 seconds')
  expect(fetchMock.mock.calls.filter(([, options]) => options?.method === 'POST')).toHaveLength(1)
})

it.each(['bad', 'Infinity', '-1', '999999'])('ignores invalid retry durations: %s', async (duration) => {
  panel()
  await screen.findByRole('button', { name: 'Create my plan' })
  fetchMock.mockResolvedValueOnce(json({}, 429, { 'Retry-After': duration }))
  await userEvent.setup().click(screen.getByRole('button', { name: 'Create my plan' }))
  expect(await screen.findByRole('alert')).not.toHaveTextContent('seconds')
})

it.each(['load', 'create'])('expires the session during %s', async (operation) => {
  if (operation === 'load') fetchMock.mockResolvedValueOnce(json({}, 401))
  panel()
  if (operation === 'create') {
    await screen.findByRole('button', { name: 'Create my plan' })
    fetchMock.mockResolvedValueOnce(json({}, 401))
    await userEvent.setup().click(screen.getByRole('button', { name: 'Create my plan' }))
  }
  await vi.waitFor(() => expect(onSessionExpired).toHaveBeenCalledOnce())
})

it('retries a failed read separately from plan creation', async () => {
  fetchMock.mockResolvedValueOnce(json({}, 403))
  panel()
  await userEvent.setup().click(await screen.findByRole('button', { name: 'Retry loading plan' }))
  expect(await screen.findByRole('button', { name: 'Create my plan' })).toBeEnabled()
  expect(fetchMock.mock.calls.every(([, options]) => !options?.method)).toBe(true)
})

it.each([
  null, {}, { ...plan(), goal: 'invalid' }, { ...plan(), version: 2 },
  { ...plan(), targets: null }, { ...plan(), targets: { ...plan().targets, protein_g: 'wrong' } },
  { ...plan(), maintenance: null }, { ...plan(), maintenance: { ...plan().maintenance, activity: null } },
  { ...plan(), target_date: '2027-99-99' }, { ...plan(), target_weight_kg: '70' },
  { ...plan(), assumptions: [false] },
])('rejects a malformed plan response: %j', async (body) => {
  fetchMock.mockResolvedValueOnce(json(body))
  panel()
  expect(await screen.findByRole('alert')).toHaveTextContent('We could not read your plan')
})

it('handles malformed JSON and allows a manual retry', async () => {
  fetchMock.mockResolvedValueOnce(new Response('bad json'))
  panel()
  expect(await screen.findByRole('alert')).toHaveTextContent('We could not read your plan')
  await userEvent.setup().click(screen.getByRole('button', { name: 'Retry loading plan' }))
  await screen.findByRole('button', { name: 'Create my plan' })
})

it('handles a network failure during creation and preserves the ability to retry', async () => {
  panel()
  await screen.findByRole('button', { name: 'Create my plan' })
  fetchMock.mockRejectedValueOnce(new TypeError('offline'))
  const user = userEvent.setup()
  await user.click(screen.getByRole('button', { name: 'Create my plan' }))
  expect(await screen.findByRole('alert')).toHaveTextContent('Could not connect')
  fetchMock.mockResolvedValueOnce(json(plan(), 201))
  await user.click(screen.getByRole('button', { name: 'Create my plan' }))
  await screen.findByRole('heading', { name: 'Your daily plan.' })
})

it.each([false, true])('cancels pending reads on unmount and ignores late results (rejected: %s)', async (reject) => {
  let finish!: (response: Response) => void
  let fail!: (error: Error) => void
  fetchMock.mockReturnValueOnce(new Promise((resolve, rejection) => { finish = resolve; fail = rejection }))
  const { unmount } = panel()
  const signal = fetchMock.mock.calls[0][1]?.signal
  unmount()
  expect(signal?.aborted).toBe(true)
  await act(async () => { if (reject) fail(new Error('aborted')); else finish(json(plan())) })
  expect(onSessionExpired).not.toHaveBeenCalled()
})

it.each([false, true])('cancels generation on unmount and ignores late results (rejected: %s)', async (reject) => {
  const { unmount } = panel()
  await screen.findByRole('button', { name: 'Create my plan' })
  let finish!: (response: Response) => void
  let fail!: (error: Error) => void
  fetchMock.mockReturnValueOnce(new Promise((resolve, rejection) => { finish = resolve; fail = rejection }))
  await userEvent.setup().click(screen.getByRole('button', { name: 'Create my plan' }))
  const signal = fetchMock.mock.calls[1][1]?.signal
  unmount()
  expect(signal?.aborted).toBe(true)
  await act(async () => { if (reject) fail(new Error('aborted')); else finish(json(plan())) })
  expect(onSessionExpired).not.toHaveBeenCalled()
})

it('clears a displayed plan when the profile changes and does not create another automatically', async () => {
  fetchMock.mockResolvedValueOnce(json(plan()))
  const { rerender } = panel()
  await screen.findByRole('heading', { name: 'Your daily plan.' })
  rerender(<PlanPanel profile={{ ...profile, current_weight_kg: 80 }} onEdit={onEdit} onSessionExpired={onSessionExpired} />)
  expect(screen.queryByRole('heading', { name: 'Your daily plan.' })).not.toBeInTheDocument()
  await screen.findByRole('button', { name: 'Create my plan' })
  expect(fetchMock.mock.calls.filter(([, options]) => options?.method === 'POST')).toHaveLength(0)
})
