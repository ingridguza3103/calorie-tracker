const requestTimeout = 90_000
const transientStatuses = new Set([500, 502, 503, 504])

const apiPaths = [
  '/api/auth/me', '/api/auth/login', '/api/auth/register', '/api/auth/logout',
  '/api/profile', '/api/plan', '/api/food/estimate', '/api/diary', '/api/diary/entries',
  '/api/health', '/api/ready',
] as const
const diaryEntryPath = /^\/api\/diary\/entries\/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

function requestUrl(path: string, query: Readonly<Record<string, string>>): URL {
  // Select static endpoints from trusted constants; UUIDs are the sole dynamic path segment.
  const endpoint = apiPaths.find((allowed) => allowed === path)
  const entry = diaryEntryPath.exec(path)?.[0] === path
  if (endpoint === undefined && !entry) throw new Error('Invalid API path.')
  let allowedKeys: string[] = []
  if (path === '/api/diary') allowedKeys = ['date']
  else if (entry) allowedKeys = ['version']
  if (Object.keys(query).some((key) => !allowedKeys.includes(key)))
    throw new Error('Invalid API query.')
  const url = new URL(endpoint ?? path, window.location.origin)
  url.search = new URLSearchParams(query).toString()
  return url
}

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
  url: URL,
  options: RequestInit & { signal: AbortSignal },
  retries: number,
): Promise<Response> {
  const { signal } = options
  const allowedOrigins = [window.location.origin]
  if (!allowedOrigins.includes(url.origin)) throw new Error('Invalid API origin.')
  for (let attempt = 0; ; attempt += 1) {
    signal.throwIfAborted()
    try {
      // Absolute URLs use the application's origin, independently of HTML <base> tags.
      const response = await fetch(url.href, options)
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
  query: Readonly<Record<string, string>> = {},
): Promise<Response> {
  const url = requestUrl(path, query)
  const timeout = AbortSignal.timeout(requestTimeout)
  const signal = init.signal ? AbortSignal.any([init.signal, timeout]) : timeout
  const readOnly = (init.method ?? 'GET').toUpperCase() === 'GET'
  return fetchWithRetries(
    url,
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
