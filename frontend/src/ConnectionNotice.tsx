import { useEffect, useState } from 'react'

export function ConnectionNotice() {
  const [waiting, setWaiting] = useState(false)
  useEffect(() => {
    const timer = setTimeout(() => setWaiting(true), 5000)
    return () => clearTimeout(timer)
  }, [])
  return waiting ? (
    <p className="connection-notice" role="status">
      Your tracker is taking a moment to wake up. Please keep this page open.
    </p>
  ) : null
}
