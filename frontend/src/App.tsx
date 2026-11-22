import { useEffect, useState } from 'react'
import { AuthForm } from './AuthForm'
import { accountErrorMessage, currentUser, signOut } from './api'
import type { User } from './api'
import { PageFrame } from './PageFrame'

type AccountState =
  | { status: 'loading' }
  | { status: 'signed-out' }
  | { status: 'signed-in'; user: User }
  | { status: 'error'; message: string }

async function loadAccount(signal?: AbortSignal): Promise<AccountState> {
  try {
    const user = await currentUser(signal)
    return user ? { status: 'signed-in', user } : { status: 'signed-out' }
  } catch (error) {
    return { status: 'error', message: accountErrorMessage(error) }
  }
}

function App() {
  const [account, setAccount] = useState<AccountState>({ status: 'loading' })
  const [loggingOut, setLoggingOut] = useState(false)
  const [logoutError, setLogoutError] = useState('')

  useEffect(() => {
    const controller = new AbortController()
    void loadAccount(controller.signal).then((restored) => {
      if (!controller.signal.aborted) setAccount(restored)
    })
    return () => controller.abort()
  }, [])

  async function logout() {
    setLoggingOut(true)
    setLogoutError('')
    try {
      await signOut()
      setAccount({ status: 'signed-out' })
    } catch (error) {
      setLogoutError(accountErrorMessage(error))
    } finally {
      setLoggingOut(false)
    }
  }

  return (
    <PageFrame>
      {account.status === 'loading' && (
        <section className="state-panel" aria-live="polite">
          <span className="loading-dot" />
          <p role="status">Checking your session…</p>
        </section>
      )}
      {account.status === 'error' && (
        <section className="state-panel">
          <h2>Let’s try that again.</h2>
          <p role="alert">{account.message}</p>
          <button
            type="button"
            className="button-primary"
            onClick={() => {
              setAccount({ status: 'loading' })
              void loadAccount().then(setAccount)
            }}
          >
            Try again <span aria-hidden="true">↗</span>
          </button>
        </section>
      )}
      {account.status === 'signed-out' && (
        <AuthForm onAuthenticated={(user) => setAccount({ status: 'signed-in', user })} />
      )}
      {account.status === 'signed-in' && (
        <section className="account-panel signed-in" aria-labelledby="signed-in-heading">
          <div className="user-avatar" aria-hidden="true">
            {account.user.username.charAt(0).toUpperCase()}
          </div>
          <p className="eyebrow">YOU’RE RIGHT WHERE YOU NEED TO BE</p>
          <h2 id="signed-in-heading">
            Welcome, <span className="username">{account.user.username}</span>.
          </h2>
          <p className="panel-intro">Your account is ready. A little clarity starts here.</p>
          <div className="diary-placeholder">
            <span className="pink-dot" />
            <div>
              <h3>A fresh page.</h3>
              <p>This is where your daily food diary and progress will live.</p>
            </div>
          </div>
          {logoutError && (
            <p className="form-error" role="alert">
              {logoutError}
            </p>
          )}
          <button type="button" className="button-secondary" onClick={logout} disabled={loggingOut}>
            {loggingOut ? 'Logging out…' : 'Log out'}
          </button>
        </section>
      )}
    </PageFrame>
  )
}

export default App
