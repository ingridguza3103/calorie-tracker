import { useCallback, useEffect, useState } from 'react'
import { AuthForm } from './AuthForm'
import { accountErrorMessage, currentUser, signOut } from './api'
import type { User } from './api'
import { PageFrame } from './PageFrame'
import { ProfilePanel } from './ProfilePanel'

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
  const sessionExpired = useCallback(
    () => setAccount({ status: 'signed-out' }),
    [],
  )

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
    <PageFrame workspace={account.status === 'signed-in'}>
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
        <AuthForm
          onAuthenticated={(user) => setAccount({ status: 'signed-in', user })}
        />
      )}
      {account.status === 'signed-in' && (
        <section
          className="profile-workspace"
          aria-labelledby="signed-in-heading"
        >
          <div className="workspace-header">
            <div>
              <p className="eyebrow">A LITTLE MORE YOU</p>
              <h1 id="signed-in-heading">
                Welcome,{' '}
                <span className="username">{account.user.username}</span>.
              </h1>
            </div>
            <button
              type="button"
              className="button-secondary"
              onClick={logout}
              disabled={loggingOut}
            >
              {loggingOut ? 'Logging out…' : 'Log out'}
            </button>
          </div>
          {logoutError && (
            <p className="form-error" role="alert">
              {logoutError}
            </p>
          )}
          <ProfilePanel
            key={account.user.id}
            onSessionExpired={sessionExpired}
          />
        </section>
      )}
    </PageFrame>
  )
}

export default App
