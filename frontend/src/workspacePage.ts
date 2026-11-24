import { useCallback, useEffect, useState } from 'react'

export type WorkspacePage = 'diary' | 'plan' | 'profile'

export function currentWorkspacePage(): WorkspacePage {
  switch (window.location.hash) {
    case '#plan': return 'plan'
    case '#profile': return 'profile'
    default: return 'diary'
  }
}

export function useWorkspacePage() {
  const [page, setPage] = useState<WorkspacePage>(currentWorkspacePage)
  useEffect(() => {
    function change() { setPage(currentWorkspacePage()) }
    window.addEventListener('hashchange', change)
    return () => window.removeEventListener('hashchange', change)
  }, [])
  const navigate = useCallback((next: WorkspacePage) => {
    window.location.hash = next
    setPage(next)
  }, [])
  return { page, navigate }
}
