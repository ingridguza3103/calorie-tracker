import { useState } from 'react'

type ConnectionStatus = 'idle' | 'checking' | 'connected' | 'error'

const messages: Record<ConnectionStatus, string> = {
  idle: 'Check that your services are ready.',
  checking: 'Checking connection…',
  connected: 'API and database connected.',
  error: 'Connection unavailable. Check your backend and database.',
}

function App() {
  const [status, setStatus] = useState<ConnectionStatus>('idle')

  async function checkConnection() {
    setStatus('checking')

    try {
      const response = await fetch('/api/ready', {
        signal: AbortSignal.timeout(8000),
      })

      if (!response.ok) {
        throw new Error('Readiness check failed')
      }

      const data = await response.json()

      if (data.status !== 'ready' || data.database !== 'connected') {
        throw new Error('Unexpected readiness response')
      }

      setStatus('connected')
    } catch {
      setStatus('error')
    }
  }

  return (
    <main className="page">
      <h1>Calorie Tracker</h1>
      <p>Your daily food diary, one meal at a time.</p>

      <section className="connection-card">
        <h2>Connection status</h2>

        <p className={`status ${status}`} role="status">
          {messages[status]}
        </p>

        <button
          type="button"
          onClick={checkConnection}
          disabled={status === 'checking'}
        >
          {status === 'checking' ? 'Checking…' : 'Check connection'}
        </button>
      </section>
    </main>
  )
}

export default App