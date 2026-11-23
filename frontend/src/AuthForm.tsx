import { useState } from 'react'
import type { FormEvent } from 'react'
import { accountErrorMessage, authenticate } from './api'
import type { AuthAction, User } from './api'
import { ConnectionNotice } from './ConnectionNotice'

interface Props {
  onAuthenticated: (user: User) => void
}

const formModes = {
  login: {
    eyebrow: 'GOOD TO SEE YOU AGAIN',
    heading: 'Welcome back.',
    intro: 'A fresh day. Your own pace. Let’s get started.',
    buttonText: 'Log in',
    pendingText: 'Logging in…',
    submitLabel: 'Log in to your account',
    usernameMin: 1,
    usernamePattern: undefined,
    usernameHelp: undefined,
    passwordMin: 1,
    passwordComplete: 'current-password',
    passwordHelp: undefined,
  },
  register: {
    eyebrow: 'A LITTLE START GOES A LONG WAY',
    heading: 'Make it your own.',
    intro: 'Create an account and take the first step.',
    buttonText: 'Create account',
    pendingText: 'Creating account…',
    submitLabel: 'Create account',
    usernameMin: 3,
    usernamePattern: '[A-Za-z0-9]+',
    usernameHelp: 'username-help',
    passwordMin: 8,
    passwordComplete: 'new-password',
    passwordHelp: 'password-help',
  },
} as const

export function AuthForm({ onAuthenticated }: Readonly<Props>) {
  const [action, setAction] = useState<AuthAction>('login')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const registering = action === 'register'
  const mode = formModes[action]

  function changeAction(next: AuthAction) {
    setAction(next)
    setError('')
    setPassword('')
    setShowPassword(false)
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setBusy(true)
    setError('')
    try {
      onAuthenticated(await authenticate(action, username, password))
    } catch (caught) {
      setError(accountErrorMessage(caught))
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="account-panel" aria-labelledby="account-heading">
      <div className="mode-switch" aria-label="Account options">
        <button
          type="button"
          aria-pressed={!registering}
          disabled={busy}
          onClick={() => changeAction('login')}
        >
          Log in
        </button>
        <button
          type="button"
          aria-pressed={registering}
          disabled={busy}
          onClick={() => changeAction('register')}
        >
          Sign up
        </button>
      </div>
      <p className="eyebrow">{mode.eyebrow}</p>
      <h2 id="account-heading">{mode.heading}</h2>
      <p className="panel-intro">{mode.intro}</p>
      <form onSubmit={submit}>
        <label htmlFor="username">Username</label>
        <input
          id="username"
          name="username"
          value={username}
          onChange={(event) => setUsername(event.target.value)}
          autoComplete="username"
          autoCapitalize="none"
          spellCheck={false}
          minLength={mode.usernameMin}
          maxLength={64}
          pattern={mode.usernamePattern}
          aria-describedby={mode.usernameHelp}
          required
          disabled={busy}
        />
        {registering && (
          <p className="field-help" id="username-help">
            3–64 letters or numbers. Usernames are case-sensitive.
          </p>
        )}
        <label htmlFor="password">Password</label>
        <div className="password-field">
          <input
            id="password"
            name="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            type={showPassword ? 'text' : 'password'}
            autoComplete={mode.passwordComplete}
            minLength={mode.passwordMin}
            maxLength={128}
            aria-describedby={mode.passwordHelp}
            required
            disabled={busy}
          />
          <button
            type="button"
            className="password-toggle"
            disabled={busy}
            aria-label={showPassword ? 'Hide password' : 'Show password'}
            aria-pressed={showPassword}
            aria-controls="password"
            onClick={() => setShowPassword((visible) => !visible)}
          >
            {showPassword ? 'Hide' : 'Show'}
          </button>
        </div>
        {registering && (
          <p className="field-help" id="password-help">
            Use 8 or more characters. Spaces and symbols are welcome.
          </p>
        )}
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        <button
          type="submit"
          className="button-primary"
          disabled={busy}
          aria-label={busy ? mode.pendingText : mode.submitLabel}
        >
          {busy ? mode.pendingText : mode.buttonText}
          <span aria-hidden="true">↗</span>
        </button>
      </form>
      {busy && <ConnectionNotice />}
      <p className="account-note">A little consistency. A little more you.</p>
    </section>
  )
}
