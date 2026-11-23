import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import App from './App'
import { goalLabels } from './profiles'
import type { Goal, Profile, ProfileInput } from './profiles'

const fetchMock = vi.fn<typeof fetch>()
const person = { id: 1, username: 'Alice' }
const input: ProfileInput = {
  goal: 'maintain',
  age: 30,
  height_cm: 168.5,
  current_weight_kg: 75,
  gender: 'female',
  activity_description: 'Desk work and evening walks.',
  gym_sessions_per_week: 2,
  steps_per_day: 6000,
  target_weight_kg: null,
  target_date: null,
}
const stored: Profile = {
  ...input,
  created_at: '2026-01-01T12:00:00Z',
  updated_at: '2026-01-01T12:00:00Z',
}
let saved: Profile | null

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function futureDate(days = 90) {
  const date = new Date()
  date.setUTCDate(date.getUTCDate() + days)
  return date.toISOString().slice(0, 10)
}

async function start(goal: Goal = 'maintain') {
  render(<App />)
  const user = userEvent.setup()
  await user.click(
    await screen.findByRole('radio', {
      name: new RegExp(`^${goalLabels[goal]}`),
    }),
  )
  await user.click(screen.getByRole('button', { name: /continue/i }))
  return user
}

async function fillDetails(user: ReturnType<typeof userEvent.setup>) {
  await user.type(screen.getByLabelText('Age (years)'), '30')
  await user.type(screen.getByLabelText('Height (cm)'), '168.5')
  await user.type(screen.getByLabelText('Current weight (kg)'), '75')
  await user.selectOptions(screen.getByLabelText('Gender'), 'female')
  await user.type(
    screen.getByLabelText('Weekly activity'),
    '  Desk work and evening walks.  ',
  )
  await user.type(screen.getByLabelText('Gym sessions per week'), '2')
  await user.type(screen.getByLabelText('Average daily steps'), '6000')
}

function profileCalls() {
  return fetchMock.mock.calls.filter(
    ([url, options]) => url === '/api/profile' && options?.method === 'PUT',
  )
}

beforeEach(() => {
  saved = null
  localStorage.clear()
  fetchMock.mockReset().mockImplementation(async (url, options) => {
    if (url === '/api/plan') return json({}, 404)
    if (url === '/api/auth/me') return json(person)
    if (url === '/api/auth/logout') return new Response(null, { status: 204 })
    if (options?.method === 'PUT') {
      saved = {
        ...stored,
        ...(JSON.parse(String(options.body)) as ProfileInput),
      }
      return json(saved, 201)
    }
    return saved ? json(saved) : json({}, 404)
  })
  vi.stubGlobal('fetch', fetchMock)
  vi.stubGlobal('matchMedia', vi.fn().mockReturnValue({ matches: false }))
})

describe('Onboarding', () => {
  it('opens the saved goal editor from a rejected calorie plan', async () => {
    saved = { ...stored, goal: 'lose', target_weight_kg: 70, target_date: futureDate(7) }
    const original = fetchMock.getMockImplementation()!
    fetchMock.mockImplementation((url, options) => {
      if (url === '/api/plan' && options?.method === 'POST')
        return Promise.resolve(json({ detail: {
          code: 'timeline_too_short', message: 'This goal needs more time.',
          suggested_target_date: futureDate(150),
        } }, 422))
      return original(url, options)
    })
    render(<App />)
    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: 'Create my plan' }))
    await user.click(await screen.findByRole('button', { name: 'Adjust goal' }))
    expect(screen.getByRole('radio', { name: /^Lose weight/ })).toBeChecked()
    await user.click(screen.getByRole('button', { name: /continue/i }))
    await user.click(screen.getByRole('button', { name: /continue/i }))
    expect(screen.getByLabelText('Target weight (kg)')).toHaveValue(70)
    fireEvent.change(screen.getByLabelText('Target date'), { target: { value: futureDate(150) } })
    await user.click(screen.getByRole('button', { name: /save profile/i }))
    expect(await screen.findByRole('button', { name: 'Create my plan' })).toBeEnabled()
    expect(saved?.target_date).toBe(futureDate(150))
  })

  it('requires a goal before continuing and supports native radio keyboard navigation', async () => {
    render(<App />)
    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: /continue/i }))
    expect(screen.getByRole('alert')).toHaveTextContent('highlighted fields')
    expect(screen.getByText('Choose a goal to continue.')).toBeInTheDocument()
    const gain = screen.getByRole('radio', { name: /^Gain weight/ })
    await waitFor(() => expect(gain).toHaveFocus())
    await user.keyboard('[Space][ArrowRight]')
    expect(screen.getByRole('radio', { name: /^Lose weight/ })).toBeChecked()
    await user.click(screen.getByRole('button', { name: /continue/i }))
    await waitFor(() => {
      expect(
        screen.getByRole('heading', { name: 'Tell us about you.' }),
      ).toHaveFocus()
    })
  })

  it('saves a maintain goal in two steps without target fields or private browser storage', async () => {
    const user = await start()
    expect(screen.getByText('Step 2 of 2')).toBeInTheDocument()
    await fillDetails(user)
    expect(
      screen.queryByLabelText('Target weight (kg)'),
    ).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: /save profile/i }))
    expect(
      await screen.findByRole('heading', { name: 'Your profile is ready.' }),
    ).toBeInTheDocument()
    expect(profileCalls()).toHaveLength(1)
    expect(profileCalls()[0]).toEqual([
      '/api/profile',
      expect.objectContaining({
        method: 'PUT',
        credentials: 'same-origin',
        cache: 'no-store',
        headers: {
          'Content-Type': 'application/json',
          'X-CSRF-Protection': '1',
        },
        body: JSON.stringify(input),
      }),
    ])
    expect(localStorage.length).toBe(1)
    expect(Object.values(localStorage).join()).not.toContain(
      input.activity_description,
    )
  })

  it.each(['gain', 'lose'] as const)(
    'saves a %s goal with a target and date',
    async (goal) => {
      const user = await start(goal)
      await fillDetails(user)
      await user.click(screen.getByRole('button', { name: /continue/i }))
      expect(screen.getByText('Step 3 of 3')).toBeInTheDocument()
      await user.type(
        screen.getByLabelText('Target weight (kg)'),
        goal === 'gain' ? '80.5' : '70.5',
      )
      fireEvent.change(screen.getByLabelText('Target date'), {
        target: { value: futureDate() },
      })
      expect(screen.getByLabelText('Target date')).toHaveAttribute(
        'min',
        futureDate(1),
      )
      await user.click(screen.getByRole('button', { name: /save profile/i }))
      await screen.findByRole('heading', { name: 'Your profile is ready.' })
      expect(saved).toMatchObject({
        ...input,
        goal,
        target_weight_kg: goal === 'gain' ? 80.5 : 70.5,
        target_date: futureDate(),
      })
      expect(screen.getByText('Target date')).toBeInTheDocument()
    },
  )

  it('keeps entered details when going back and clears obsolete targets when switching to maintain', async () => {
    const user = await start('gain')
    await fillDetails(user)
    await user.click(screen.getByRole('button', { name: /continue/i }))
    await user.type(screen.getByLabelText('Target weight (kg)'), '80')
    fireEvent.change(screen.getByLabelText('Target date'), {
      target: { value: futureDate() },
    })
    await user.click(screen.getByRole('button', { name: 'Back' }))
    expect(screen.getByLabelText('Height (cm)')).toHaveValue(168.5)
    await user.click(screen.getByRole('button', { name: 'Back' }))
    await user.click(screen.getByRole('radio', { name: /^Maintain weight/ }))
    await user.click(screen.getByRole('button', { name: /continue/i }))
    expect(screen.getByLabelText('Weekly activity')).toHaveValue(
      '  Desk work and evening walks.  ',
    )
    await user.click(screen.getByRole('button', { name: /save profile/i }))
    await screen.findByRole('heading', { name: 'Your profile is ready.' })
    expect(saved).toMatchObject({
      goal: 'maintain',
      target_weight_kg: null,
      target_date: null,
    })
  })

  it('shows inline errors, focuses the first invalid field, and accepts zero activity counts', async () => {
    const user = await start()
    await user.click(screen.getByRole('button', { name: /save profile/i }))
    await waitFor(() => expect(screen.getByLabelText('Age (years)')).toHaveFocus())
    expect(screen.getByLabelText('Age (years)')).toHaveAttribute(
      'aria-invalid',
      'true',
    )
    expect(
      screen.getByText('Describe your week in 1–2,000 characters.'),
    ).toBeInTheDocument()
    expect(screen.getByText('Choose an option.')).toBeInTheDocument()
    expect(profileCalls()).toHaveLength(0)
    await fillDetails(user)
    for (const label of ['Gym sessions per week', 'Average daily steps']) {
      await user.clear(screen.getByLabelText(label))
      await user.type(screen.getByLabelText(label), '0')
    }
    await user.click(screen.getByRole('button', { name: /save profile/i }))
    await screen.findByRole('heading', { name: 'Your profile is ready.' })
    expect(saved).toMatchObject({ gym_sessions_per_week: 0, steps_per_day: 0 })
  })

  it('rejects underage values, out-of-range measurements, and fractional counts before saving', async () => {
    const user = await start()
    await fillDetails(user)
    fireEvent.change(screen.getByLabelText('Age (years)'), {
      target: { value: '17' },
    })
    fireEvent.change(screen.getByLabelText('Height (cm)'), {
      target: { value: '301' },
    })
    fireEvent.change(screen.getByLabelText('Gym sessions per week'), {
      target: { value: '2.5' },
    })
    await user.click(screen.getByRole('button', { name: /save profile/i }))
    expect(
      screen.getByText('Enter a value from 18 to 120.'),
    ).toBeInTheDocument()
    expect(
      screen.getByText('Enter a value from 50 to 300.'),
    ).toBeInTheDocument()
    expect(screen.getByText('Enter a whole number.')).toBeInTheDocument()
    expect(profileCalls()).toHaveLength(0)
  })

  it.each(['gain', 'lose'] as const)(
    'checks target direction and the deadline for a %s goal',
    async (goal) => {
      const user = await start(goal)
      await fillDetails(user)
      await user.click(screen.getByRole('button', { name: /continue/i }))
      await user.click(screen.getByRole('button', { name: /save profile/i }))
      expect(
        screen.getByText('Enter a weight from 20 to 500 kg.'),
      ).toBeInTheDocument()
      expect(
        screen.getByText('Choose a date after today (UTC).'),
      ).toBeInTheDocument()
      await user.type(screen.getByLabelText('Target weight (kg)'), '75')
      fireEvent.change(screen.getByLabelText('Target date'), {
        target: { value: futureDate(0) },
      })
      await user.click(screen.getByRole('button', { name: /save profile/i }))
      expect(
        screen.getByText(
          `Choose a target ${goal === 'gain' ? 'above' : 'below'} your current weight.`,
        ),
      ).toBeInTheDocument()
      expect(profileCalls()).toHaveLength(0)
    },
  )

  it('restores a saved profile, pre-fills editing, and discards cancelled changes', async () => {
    saved = stored
    render(<App />)
    const user = userEvent.setup()
    await user.click(
      await screen.findByRole('button', { name: 'Edit profile' }),
    )
    expect(
      screen.getByRole('radio', { name: /^Maintain weight/ }),
    ).toBeChecked()
    await user.click(screen.getByRole('button', { name: /continue/i }))
    expect(screen.getByLabelText('Age (years)')).toHaveValue(30)
    await user.clear(screen.getByLabelText('Age (years)'))
    await user.type(screen.getByLabelText('Age (years)'), '31')
    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.getByText('30 years')).toBeInTheDocument()
    expect(profileCalls()).toHaveLength(0)
    await user.click(screen.getByRole('button', { name: 'Edit profile' }))
    await user.click(screen.getByRole('button', { name: /continue/i }))
    await user.clear(screen.getByLabelText('Age (years)'))
    await user.type(screen.getByLabelText('Age (years)'), '31')
    await user.click(screen.getByRole('button', { name: /save profile/i }))
    expect(await screen.findByText('31 years')).toBeInTheDocument()
  })

  it('reads expired targets and requires a new date when editing', async () => {
    saved = {
      ...stored,
      goal: 'lose',
      target_weight_kg: 70,
      target_date: '2020-01-01',
    }
    render(<App />)
    const user = userEvent.setup()
    await user.click(
      await screen.findByRole('button', { name: 'Edit profile' }),
    )
    await user.click(screen.getByRole('button', { name: /continue/i }))
    await user.click(screen.getByRole('button', { name: /continue/i }))
    expect(screen.getByLabelText('Target weight (kg)')).toHaveValue(70)
    expect(screen.getByLabelText('Target date')).toHaveValue('2020-01-01')
    await user.click(screen.getByRole('button', { name: /save profile/i }))
    expect(
      screen.getByText('Choose a date after today (UTC).'),
    ).toBeInTheDocument()
  })

  it('disables fields and navigation during a save and preserves the draft after a failed save', async () => {
    const user = await start()
    await fillDetails(user)
    let finish!: (response: Response) => void
    fetchMock.mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve
      }),
    )
    await user.click(screen.getByRole('button', { name: /save profile/i }))
    expect(screen.getByLabelText('Age (years)')).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Back' })).toBeDisabled()
    expect(screen.getByRole('button', { name: /saving/i })).toBeDisabled()
    await act(async () => {
      finish(json({}, 422))
    })
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Check your profile details',
    )
    expect(screen.getByLabelText('Age (years)')).toHaveValue(30)
    await user.click(screen.getByRole('button', { name: /save profile/i }))
    await screen.findByRole('heading', { name: 'Your profile is ready.' })
  })

  it.each([403, 429, 500])(
    'shows a recoverable save error for HTTP %s',
    async (status) => {
      saved = stored
      render(<App />)
      const user = userEvent.setup()
      await user.click(
        await screen.findByRole('button', { name: 'Edit profile' }),
      )
      await user.click(screen.getByRole('button', { name: /continue/i }))
      fetchMock.mockResolvedValueOnce(json({}, status))
      await user.click(screen.getByRole('button', { name: /save profile/i }))
      expect(await screen.findByRole('alert')).toBeInTheDocument()
      expect(screen.getByLabelText('Weekly activity')).toHaveValue(
        input.activity_description,
      )
      expect(
        screen.getByRole('button', { name: /save profile/i }),
      ).toBeEnabled()
    },
  )

  it.each(['load', 'save'] as const)(
    'returns to login if the session expires during %s',
    async (phase) => {
      if (phase === 'load') {
        fetchMock
          .mockResolvedValueOnce(json(person))
          .mockResolvedValueOnce(json({}, 401))
        render(<App />)
      } else {
        const user = await start()
        await fillDetails(user)
        fetchMock.mockResolvedValueOnce(json({}, 401))
        await user.click(screen.getByRole('button', { name: /save profile/i }))
      }
      expect(
        await screen.findByRole('heading', { name: 'Welcome back.' }),
      ).toBeInTheDocument()
      expect(
        screen.queryByRole('heading', { name: 'Tell us about you.' }),
      ).not.toBeInTheDocument()
    },
  )

  it('shows loading and retry states without treating a failed profile request as a new account', async () => {
    let finish!: (response: Response) => void
    fetchMock
      .mockResolvedValueOnce(json(person))
      .mockReturnValueOnce(
        new Promise((resolve) => {
          finish = resolve
        }),
      )
      .mockResolvedValueOnce(json({}, 500))
      .mockResolvedValueOnce(json({}, 500))
    render(<App />)
    expect(await screen.findByText('Loading your profile…')).toHaveAttribute(
      'role',
      'status',
    )
    await act(async () => {
      finish(json({}, 500))
    })
    expect(
      await screen.findByRole('alert', {}, { timeout: 3000 }),
    ).toHaveTextContent('Could not save or load')
    expect(screen.queryByRole('radio')).not.toBeInTheDocument()
    await userEvent
      .setup()
      .click(screen.getByRole('button', { name: 'Retry profile' }))
    await screen.findByRole('heading', { name: 'What’s your goal?' })
  })

  it.each([
    null,
    {},
    { ...stored, age: 'wrong' },
    { ...stored, target_date: 42 },
  ])('handles an invalid profile response: %j', async (value) => {
    fetchMock
      .mockResolvedValueOnce(json(person))
      .mockResolvedValueOnce(json(value))
    render(<App />)
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'We could not read your profile',
    )
    expect(screen.getByRole('button', { name: 'Retry profile' })).toBeEnabled()
  })

  it('recovers from a network failure during saving', async () => {
    const user = await start()
    await fillDetails(user)
    fetchMock.mockRejectedValueOnce(new TypeError('offline'))
    await user.click(screen.getByRole('button', { name: /save profile/i }))
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Could not connect',
    )
    await user.click(screen.getByRole('button', { name: /save profile/i }))
    await screen.findByRole('heading', { name: 'Your profile is ready.' })
  })

  it.each([false, true])(
    'aborts profile loading on logout and ignores late replies (rejected: %s)',
    async (rejected) => {
      let finish!: (response: Response) => void
      let fail!: (error: Error) => void
      fetchMock.mockResolvedValueOnce(json(person)).mockReturnValueOnce(
        new Promise((resolve, reject) => {
          finish = resolve
          fail = reject
        }),
      )
      render(<App />)
      await screen.findByText('Loading your profile…')
      await waitFor(() => {
        expect(fetchMock).toHaveBeenCalledWith(
          '/api/profile',
          expect.objectContaining({ signal: expect.any(AbortSignal) }),
        )
      })
      const signal = fetchMock.mock.calls.find(
        ([url]) => url === '/api/profile',
      )?.[1]?.signal
      expect(signal?.aborted).toBe(false)
      await userEvent
        .setup()
        .click(screen.getByRole('button', { name: 'Log out' }))
      await screen.findByRole('heading', { name: 'Welcome back.' })
      expect(signal?.aborted).toBe(true)
      await act(async () => {
        if (rejected) fail(new Error('aborted'))
        else finish(json(stored))
      })
      expect(
        screen.queryByRole('button', { name: 'Edit profile' }),
      ).not.toBeInTheDocument()
    },
  )

  it.each([false, true])(
    'aborts a save when leaving and ignores its late result (rejected: %s)',
    async (rejected) => {
      const user = await start()
      await fillDetails(user)
      let finish!: (response: Response) => void
      let fail!: (error: Error) => void
      fetchMock.mockReturnValueOnce(
        new Promise((resolve, reject) => {
          finish = resolve
          fail = reject
        }),
      )
      await user.click(screen.getByRole('button', { name: /save profile/i }))
      const signal = profileCalls()[0]?.[1]?.signal
      await user.click(screen.getByRole('button', { name: 'Log out' }))
      await screen.findByRole('heading', { name: 'Welcome back.' })
      expect(signal?.aborted).toBe(true)
      await act(async () => {
        if (rejected) fail(new Error('aborted'))
        else finish(json(stored))
      })
      expect(
        screen.queryByRole('heading', { name: 'Your profile is ready.' }),
      ).not.toBeInTheDocument()
    },
  )

  it('does not expose a previous account’s profile after logging out and signing in again', async () => {
    saved = stored
    render(<App />)
    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: 'Log out' }))
    await screen.findByRole('heading', { name: 'Welcome back.' })
    saved = null
    await user.type(screen.getByLabelText('Username'), 'Bob')
    await user.type(screen.getByLabelText('Password'), 'another sample phrase')
    fetchMock.mockResolvedValueOnce(json({ id: 2, username: 'Bob' }))
    await user.click(
      screen.getByRole('button', { name: 'Log in to your account' }),
    )
    await screen.findByRole('heading', { name: 'Welcome, Bob.' })
    await screen.findByRole('heading', { name: 'What’s your goal?' })
    expect(screen.queryByText('30 years')).not.toBeInTheDocument()
    expect(
      screen.getByRole('radio', { name: /^Maintain weight/ }),
    ).not.toBeChecked()
  })
})
