import { act, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import App from './App'
import { THEME_KEY } from './theme'

const fetchMock = vi.fn<typeof fetch>()
const person = { id: 1, username: 'Alice' }
const passphrase = 'a sample phrase for testing'

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

async function loginForm() {
  render(<App />)
  await screen.findByRole('heading', { name: 'Welcome back.' })
  const user = userEvent.setup()
  await user.type(screen.getByLabelText('Username'), person.username)
  await user.type(screen.getByLabelText('Password'), passphrase)
  return user
}

beforeEach(() => {
  localStorage.clear()
  delete document.documentElement.dataset.theme
  fetchMock.mockReset().mockImplementation(() => Promise.resolve(json({}, 401)))
  vi.stubGlobal('fetch', fetchMock)
  vi.stubGlobal('matchMedia', vi.fn().mockReturnValue({ matches: false }))
})

describe('Accounts', () => {
  it('checks the existing session before displaying the login form', async () => {
    let finish!: (response: Response) => void
    fetchMock.mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve
      }),
    )
    render(<App />)
    expect(screen.getByRole('status')).toHaveTextContent('Checking your session')
    await act(async () => {
      finish(json({}, 401))
    })
    expect(await screen.findByRole('heading', { name: 'Welcome back.' })).toBeInTheDocument()
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/auth/me',
      expect.objectContaining({ credentials: 'same-origin' }),
    )
  })

  it('logs in, shows pending state, and displays the authenticated user', async () => {
    let finish!: (response: Response) => void
    fetchMock.mockResolvedValueOnce(json({}, 401)).mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve
      }),
    )
    const user = await loginForm()
    await user.click(screen.getByRole('button', { name: 'Log in to your account' }))
    expect(screen.getByRole('button', { name: /logging in/i })).toBeDisabled()
    expect(screen.getByLabelText('Username')).toBeDisabled()
    expect(fetchMock).toHaveBeenLastCalledWith(
      '/api/auth/login',
      expect.objectContaining({
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Protection': '1' },
        body: JSON.stringify({ username: person.username, password: passphrase }),
      }),
    )
    await act(async () => {
      finish(json(person))
    })
    expect(await screen.findByRole('heading', { name: 'Welcome, Alice.' })).toBeInTheDocument()
    expect(localStorage.length).toBe(1)
    expect(localStorage.getItem(THEME_KEY)).toBe('light')
  })

  it('registers an account and supports showing and hiding the password', async () => {
    let finish!: (response: Response) => void
    fetchMock.mockResolvedValueOnce(json({}, 401)).mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve
      }),
    )
    render(<App />)
    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: 'Sign up' }))
    expect(screen.getByRole('heading', { name: 'Make it your own.' })).toBeInTheDocument()
    expect(screen.getByLabelText('Password')).toHaveAttribute('minlength', '8')
    await user.type(screen.getByLabelText('Username'), person.username)
    await user.type(screen.getByLabelText('Password'), passphrase)
    await user.click(screen.getByRole('button', { name: 'Show password' }))
    expect(screen.getByLabelText('Password')).toHaveAttribute('type', 'text')
    await user.click(screen.getByRole('button', { name: 'Hide password' }))
    expect(screen.getByLabelText('Password')).toHaveAttribute('type', 'password')
    await user.click(screen.getByRole('button', { name: 'Create account' }))
    expect(screen.getByRole('button', { name: /creating account/i })).toBeDisabled()
    expect(fetchMock.mock.calls.at(-1)?.[0]).toBe('/api/auth/register')
    await act(async () => {
      finish(json(person, 201))
    })
    expect(await screen.findByRole('heading', { name: 'Welcome, Alice.' })).toBeInTheDocument()
  })

  it.each([
    [401, 'Incorrect username or password.'],
    [403, 'This request could not be verified. Refresh the page and try again.'],
    [409, 'That username is already taken. Please choose another.'],
    [422, 'Check your username and password, then try again.'],
    [429, 'Too many attempts. Please wait a minute and try again.'],
    [500, 'Something went wrong. Please try again.'],
  ])('shows a useful message for HTTP %s and lets the user retry', async (status, message) => {
    fetchMock.mockResolvedValueOnce(json({}, 401)).mockResolvedValueOnce(json({}, status))
    const user = await loginForm()
    await user.click(screen.getByRole('button', { name: 'Log in to your account' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(message)
    expect(screen.getByRole('button', { name: 'Log in to your account' })).toBeEnabled()
  })

  it('handles network failures during form submission', async () => {
    fetchMock.mockResolvedValueOnce(json({}, 401)).mockRejectedValueOnce(new TypeError('offline'))
    const user = await loginForm()
    await user.click(screen.getByRole('button', { name: 'Log in to your account' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not connect.')
  })

  it.each([null, {}, { id: 'wrong', username: 'Alice' }, { id: 1 }, { id: 1, username: 2 }])(
    'handles an invalid account response: %j',
    async (body) => {
      fetchMock.mockResolvedValueOnce(json({}, 401)).mockResolvedValueOnce(json(body))
      const user = await loginForm()
      await user.click(screen.getByRole('button', { name: 'Log in to your account' }))
      expect(await screen.findByRole('alert')).toHaveTextContent('We could not load your account.')
    },
  )

  it('handles malformed JSON in the account response', async () => {
    fetchMock
      .mockResolvedValueOnce(json({}, 401))
      .mockResolvedValueOnce(new Response('invalid JSON'))
    const user = await loginForm()
    await user.click(screen.getByRole('button', { name: 'Log in to your account' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not connect.')
  })

  it('clears the password and errors when changing form mode', async () => {
    fetchMock.mockResolvedValueOnce(json({}, 401)).mockResolvedValueOnce(json({}, 401))
    const user = await loginForm()
    await user.click(screen.getByRole('button', { name: 'Show password' }))
    await user.click(screen.getByRole('button', { name: 'Log in to your account' }))
    await screen.findByRole('alert')
    await user.click(screen.getByRole('button', { name: 'Sign up' }))
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(screen.getByLabelText('Password')).toHaveValue('')
    expect(screen.getByLabelText('Password')).toHaveAttribute('type', 'password')
    await user.click(screen.getByRole('button', { name: /^Log in$/ }))
    expect(screen.getByRole('heading', { name: 'Welcome back.' })).toBeInTheDocument()
  })

  it('restores a signed-in user and logs out', async () => {
    let finish!: (response: Response) => void
    fetchMock.mockResolvedValueOnce(json(person)).mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve
      }),
    )
    render(<App />)
    expect(await screen.findByRole('heading', { name: 'Welcome, Alice.' })).toBeInTheDocument()
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: 'Log out' }))
    expect(screen.getByRole('button', { name: 'Logging out…' })).toBeDisabled()
    expect(fetchMock).toHaveBeenLastCalledWith(
      '/api/auth/logout',
      expect.objectContaining({
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'X-CSRF-Protection': '1' },
      }),
    )
    await act(async () => {
      finish(new Response(null, { status: 204 }))
    })
    expect(await screen.findByRole('heading', { name: 'Welcome back.' })).toBeInTheDocument()
  })

  it('retains the user after a failed logout and allows another attempt', async () => {
    fetchMock
      .mockResolvedValueOnce(json(person))
      .mockRejectedValueOnce(new TypeError('offline'))
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
    render(<App />)
    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: 'Log out' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not connect.')
    expect(screen.getByRole('heading', { name: 'Welcome, Alice.' })).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Log out' }))
    expect(await screen.findByRole('heading', { name: 'Welcome back.' })).toBeInTheDocument()
  })

  it('lets the user retry a failed session check', async () => {
    fetchMock.mockResolvedValueOnce(json({}, 500)).mockResolvedValueOnce(json({}, 401))
    render(<App />)
    expect(await screen.findByRole('alert')).toHaveTextContent('Something went wrong.')
    await userEvent.setup().click(screen.getByRole('button', { name: /try again/i }))
    expect(await screen.findByRole('heading', { name: 'Welcome back.' })).toBeInTheDocument()
  })

  it.each([false, true])('cancels the session check on unmount (rejected: %s)', async (reject) => {
    let finish!: (value: Response) => void
    let fail!: (reason: Error) => void
    fetchMock.mockReturnValueOnce(
      new Promise((resolve, rejection) => {
        finish = resolve
        fail = rejection
      }),
    )
    const { unmount } = render(<App />)
    const signal = fetchMock.mock.calls[0]?.[1]?.signal
    unmount()
    expect(signal?.aborted).toBe(true)
    await act(async () => {
      if (reject) fail(new Error('cancelled'))
      else finish(json(person))
    })
  })
})

describe('Theme', () => {
  it('switches the colors and remembers the choice', async () => {
    render(<App />)
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: 'Switch to dark mode' }))
    expect(document.documentElement).toHaveAttribute('data-theme', 'dark')
    expect(localStorage.getItem(THEME_KEY)).toBe('dark')
    await user.click(screen.getByRole('button', { name: 'Switch to light mode' }))
    expect(document.documentElement).toHaveAttribute('data-theme', 'light')
    await screen.findByRole('heading', { name: 'Welcome back.' })
  })

  it.each(['dark', 'light'])('uses the saved %s theme', async (theme) => {
    localStorage.setItem(THEME_KEY, theme)
    render(<App />)
    await screen.findByRole('heading', { name: 'Welcome back.' })
    expect(document.documentElement).toHaveAttribute('data-theme', theme)
  })

  it('uses the system preference when no valid theme is saved', async () => {
    localStorage.setItem(THEME_KEY, 'invalid')
    vi.stubGlobal('matchMedia', vi.fn().mockReturnValue({ matches: true }))
    render(<App />)
    await screen.findByRole('heading', { name: 'Welcome back.' })
    expect(document.documentElement).toHaveAttribute('data-theme', 'dark')
  })

  it('works when storage and matchMedia are unavailable', async () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked')
    })
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked')
    })
    vi.stubGlobal('matchMedia', undefined)
    render(<App />)
    await userEvent.setup().click(screen.getByRole('button', { name: 'Switch to dark mode' }))
    expect(document.documentElement).toHaveAttribute('data-theme', 'dark')
    await screen.findByRole('heading', { name: 'Welcome back.' })
  })
})
