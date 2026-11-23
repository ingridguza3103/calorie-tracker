import type { ReactNode } from 'react'
import { useTheme } from './theme'

export function PageFrame({
  children,
  workspace = false,
}: Readonly<{ children: ReactNode; workspace?: boolean }>) {
  const { theme, toggleTheme } = useTheme()
  return (
    <div className="app-shell">
      <header className="site-header">
        <a className="brand" href="/" aria-label="Calorie Tracker home">
          <span className="brand-mark" aria-hidden="true">
            <svg viewBox="0 0 32 32" fill="none">
              <path
                d="M9 22c9 2 15-4 14-14-10-1-16 5-14 14Z"
                stroke="currentColor"
                strokeWidth="2"
              />
              <path
                d="m10 22 9-9M14 18v-5m0 5h5"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
              />
            </svg>
          </span>
          <span>
            calorie<span className="brand-subtitle">TRACKER</span>
          </span>
        </a>
        <button
          type="button"
          className="theme-toggle"
          onClick={toggleTheme}
          aria-label={`Switch to ${theme === 'light' ? 'dark' : 'light'} mode`}
        >
          <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
            {theme === 'light' ? (
              <path
                d="M20 14.2A8.5 8.5 0 0 1 9.8 4 8.5 8.5 0 1 0 20 14.2Z"
                stroke="currentColor"
                strokeWidth="1.7"
                strokeLinejoin="round"
              />
            ) : (
              <>
                <circle
                  cx="12"
                  cy="12"
                  r="4"
                  stroke="currentColor"
                  strokeWidth="1.7"
                />
                <path
                  d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.5 1.5m11 11L19 19M5 19l1.5-1.5m11-11L19 5"
                  stroke="currentColor"
                  strokeWidth="1.7"
                  strokeLinecap="round"
                />
              </>
            )}
          </svg>
          <span>{theme === 'light' ? 'Dark mode' : 'Light mode'}</span>
        </button>
      </header>

      <main className={workspace ? 'workspace-layout' : 'account-layout'}>
        {!workspace && (
          <section className="welcome-panel" aria-labelledby="welcome-heading">
            <p className="eyebrow">
              <span className="pink-dot" /> YOUR DAY, A LITTLE CLEARER
            </p>
            <h1 id="welcome-heading">
              <span className="headline-line">Your food.</span>
              <span className="headline-line">Your goals.</span>
              <span className="headline-line headline-highlight">
                Your own pace.
              </span>
            </h1>
            <p className="welcome-copy">
              Build a little awareness.
              <br />
              Make room for the habits that feel like you.
            </p>
            <div className="balance-art" aria-hidden="true">
              <div className="orbit orbit-one" />
              <div className="orbit orbit-two" />
              <div className="balance-disc">
                <span>little by little</span>
                <svg viewBox="0 0 64 64" fill="none">
                  <path
                    d="m14 35 12 12 25-29"
                    stroke="currentColor"
                    strokeWidth="4"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
                <span>every day.</span>
              </div>
              <span className="art-label label-food">a little balance</span>
              <span className="art-label label-you">a little more you</span>
            </div>
            <p className="welcome-footer">SMALL STEPS. REAL LIFE.</p>
          </section>
        )}

        <div className={workspace ? 'workspace-content' : 'account-content'}>
          {children}
        </div>
      </main>
      <footer className="site-footer">
        <span>CALORIE TRACKER</span>
        <span>A little more clarity. Every day.</span>
      </footer>
    </div>
  )
}
