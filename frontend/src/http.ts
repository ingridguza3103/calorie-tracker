const requestTimeout = 90_000
const transientStatuses = new Set([500, 502, 503, 504])

function pause(milliseconds: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted()
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', cancel)
      resolve()
    }, milliseconds)
    function cancel() {
      clearTimeout(timer)
      reject(signal.reason)
    }
    signal.addEventListener('abort', cancel, { once: true })
  })
}

async function fetchWithRetries(
  path: string,
  options: RequestInit & { signal: AbortSignal },
  retries: number,
): Promise<Response> {
  const { signal } = options
  for (let attempt = 0; ; attempt += 1) {
    signal.throwIfAborted()
    try {
      const response = await fetch(path, options)
      signal.throwIfAborted()
      const warmingPage =
        response.ok &&
        response.headers.get('content-type')?.includes('text/html')
      if (
        attempt >= retries ||
        (!transientStatuses.has(response.status) && !warmingPage)
      )
        return response
    } catch (error) {
      if (signal.aborted) throw signal.reason
      if (attempt >= retries) throw error
    }
    await pause(500 * (attempt + 1), signal)
  }
}

export async function apiRequest(
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  if (!path.startsWith('/api/')) throw new Error('Invalid API path.')
  const timeout = AbortSignal.timeout(requestTimeout)
  const signal = init.signal ? AbortSignal.any([init.signal, timeout]) : timeout
  const readOnly = (init.method ?? 'GET').toUpperCase() === 'GET'
  return fetchWithRetries(
    path,
    {
      ...init,
      signal,
      credentials: 'same-origin',
      mode: 'same-origin',
      redirect: 'error',
      cache: 'no-store',
    },
    readOnly ? 2 : 0,
  )
}
