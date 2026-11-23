import { vi } from 'vitest'

// UI/API tests inspect route-relative paths. The HTTP boundary tests inspect raw URLs.
export function stubApiFetch(mock: typeof fetch) {
  vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => {
    if (typeof input !== 'string') throw new Error('Expected an absolute request URL.')
    const url = new URL(input)
    if (url.origin !== window.location.origin) throw new Error('Unexpected API origin.')
    return mock(url.pathname + url.search, init)
  })
}
