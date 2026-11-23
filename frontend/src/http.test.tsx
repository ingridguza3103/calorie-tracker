import { act, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { accountErrorMessage } from './api'
import { ConnectionNotice } from './ConnectionNotice'
import { apiRequest } from './http'

const fetchMock = vi.fn<typeof fetch>()
function json(status = 200) {
  return new Response('{}', {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

beforeEach(() => {
  vi.useFakeTimers()
  fetchMock.mockReset()
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  vi.useRealTimers()
})

it('recovers a read from transient server errors using one overall 90-second timeout', async () => {
  const timeout = vi.spyOn(AbortSignal, 'timeout')
  fetchMock
    .mockResolvedValueOnce(json(503))
    .mockResolvedValueOnce(json(502))
    .mockResolvedValueOnce(json())
  const result = apiRequest('/api/auth/me')
  await vi.runAllTimersAsync()
  expect((await result).status).toBe(200)
  expect(fetchMock).toHaveBeenCalledTimes(3)
  expect(timeout).toHaveBeenCalledWith(90_000)
  expect(fetchMock.mock.calls[0]?.[1]?.signal).toBe(
    fetchMock.mock.calls[2]?.[1]?.signal,
  )
})

it('recovers after a network interruption or an HTML waking page', async () => {
  fetchMock
    .mockRejectedValueOnce(new TypeError('offline'))
    .mockResolvedValueOnce(
      new Response('<html>Starting</html>', {
        headers: { 'Content-Type': 'text/html' },
      }),
    )
    .mockResolvedValueOnce(json())
  const result = apiRequest('/api/profile')
  await vi.runAllTimersAsync()
  expect((await result).status).toBe(200)
  expect(fetchMock).toHaveBeenCalledTimes(3)
})

it('returns an exhausted HTTP failure so the UI can offer a manual retry', async () => {
  fetchMock.mockImplementation(async () => json(503))
  const result = apiRequest('/api/auth/me')
  await vi.runAllTimersAsync()
  expect((await result).status).toBe(503)
  expect(fetchMock).toHaveBeenCalledTimes(3)
})

it('stops retrying a read after repeated network failures', async () => {
  fetchMock.mockRejectedValue(new TypeError('offline'))
  const result = expect(apiRequest('/api/profile')).rejects.toThrow('offline')
  await vi.runAllTimersAsync()
  await result
  expect(fetchMock).toHaveBeenCalledTimes(3)
})

it.each(['POST', 'PUT', 'DELETE'])(
  'does not automatically repeat a %s operation',
  async (method) => {
    fetchMock.mockResolvedValueOnce(json(503))
    expect((await apiRequest('/api/profile', { method })).status).toBe(503)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  },
)

it('does not replay a failed write after a network failure', async () => {
  fetchMock.mockRejectedValueOnce(new TypeError('offline'))
  await expect(
    apiRequest('/api/auth/register', { method: 'POST' }),
  ).rejects.toThrow('offline')
  expect(fetchMock).toHaveBeenCalledTimes(1)
})

it.each([401, 403, 404, 422, 429])('does not retry HTTP %s', async (status) => {
  fetchMock.mockResolvedValueOnce(json(status))
  expect((await apiRequest('/api/profile')).status).toBe(status)
  expect(fetchMock).toHaveBeenCalledTimes(1)
})

it('cancels a retry delay when the page or account changes', async () => {
  fetchMock.mockResolvedValueOnce(json(503))
  const controller = new AbortController()
  const result = expect(
    apiRequest('/api/profile', { signal: controller.signal }),
  ).rejects.toMatchObject({ name: 'AbortError' })
  await vi.advanceTimersByTimeAsync(0)
  controller.abort()
  await result
  await vi.runAllTimersAsync()
  expect(fetchMock).toHaveBeenCalledTimes(1)
})

it('rejects an already cancelled request without contacting the server', async () => {
  const controller = new AbortController()
  controller.abort()
  await expect(
    apiRequest('/api/profile', { signal: controller.signal }),
  ).rejects.toMatchObject({ name: 'AbortError' })
  expect(fetchMock).not.toHaveBeenCalled()
})

it('reports a timeout as recoverable feedback', async () => {
  const controller = new AbortController()
  vi.spyOn(AbortSignal, 'timeout').mockReturnValue(controller.signal)
  fetchMock.mockImplementation(async () => {
    controller.abort(new DOMException('Timed out', 'TimeoutError'))
    throw new TypeError('connection closed')
  })
  let message = ''
  try {
    await apiRequest('/api/auth/me')
  } catch (error) {
    message = accountErrorMessage(error)
  }
  expect(message).toContain('Please try again')
  expect(fetchMock).toHaveBeenCalledTimes(1)
})

it('rejects paths outside the application API', async () => {
  await expect(apiRequest('https://other.example')).rejects.toThrow(
    'Invalid API path',
  )
  expect(fetchMock).not.toHaveBeenCalled()
})

it.each([
  'https://evil.example/api/profile', '//evil.example/api/profile',
  '/api/../auth/logout', '/api/%2e%2e/auth/logout', '/api/profile/../auth/logout',
  '/api/profile/../../outside', '/api/profile?redirect=https://evil.example',
  '/api/profile#fragment', '/api/unknown', '/api/profile/extra',
  '/api/diary?date=2026-11-23', '/api/diary/entries/../../auth/logout',
  '/api/diary/entries/daab1898-b871-4895-b395-98838fd82525%2f..',
  '/api/diary/entries/not-a-uuid', '/api\\profile', ' /api/profile', '/api/profile\n',
  '/api/diary/entries/daab1898-b871-4895-b395-98838fd82525\n',
])('rejects an unapproved or disguised endpoint before fetching: %s', async (path) => {
  await expect(apiRequest(path)).rejects.toThrow('Invalid API path')
  expect(fetchMock).not.toHaveBeenCalled()
})

it.each([
  ['/api/profile', { date: '2026-11-23' }],
  ['/api/diary', { redirect: 'https://evil.example' }],
  ['/api/diary', { date: '2026-11-23', version: '1' }],
])('rejects unexpected query keys on %s', async (path, query) => {
  await expect(apiRequest(path as string, {}, query as Record<string, string>)).rejects.toThrow('Invalid API query')
  expect(fetchMock).not.toHaveBeenCalled()
})

it('keeps delimiter-like query text inside one parameter on the fixed same-origin endpoint', async () => {
  const supplied = '2026-11-23&redirect=https://evil.example/api#fragment'
  fetchMock.mockResolvedValueOnce(json())
  await apiRequest('/api/diary', {}, { date: supplied })
  const target = new URL(String(fetchMock.mock.calls[0][0]))
  expect(target.origin).toBe(window.location.origin)
  expect(target.pathname).toBe('/api/diary')
  expect([...target.searchParams.keys()]).toEqual(['date'])
  expect(target.searchParams.get('date')).toBe(supplied)
  expect(target.hash).toBe('')
})

it('permits only a UUIDv4 entry path and keeps the deletion version in the query', async () => {
  fetchMock.mockResolvedValueOnce(json())
  await apiRequest('/api/diary/entries/daab1898-b871-4895-b395-98838fd82525', { method: 'DELETE' }, { version: '3' })
  expect(fetchMock).toHaveBeenCalledWith(
    window.location.origin + '/api/diary/entries/daab1898-b871-4895-b395-98838fd82525?version=3',
    expect.objectContaining({ method: 'DELETE' }),
  )
})

it('uses the page origin even when an HTML base points to another origin', async () => {
  const base = document.createElement('base')
  base.href = 'https://evil.example/elsewhere/'
  document.head.append(base)
  fetchMock.mockResolvedValueOnce(json())
  try {
    await apiRequest('/api/profile')
    expect(fetchMock).toHaveBeenCalledWith(
      window.location.origin + '/api/profile', expect.anything(),
    )
  } finally {
    base.remove()
  }
})

it('pins credentials, mode, redirects and caching even if request options try to override them', async () => {
  fetchMock.mockResolvedValueOnce(json())
  await apiRequest('/api/profile', {
    credentials: 'include', mode: 'cors', redirect: 'follow', cache: 'force-cache',
  })
  expect(fetchMock).toHaveBeenCalledWith(window.location.origin + '/api/profile', expect.objectContaining({
    credentials: 'same-origin', mode: 'same-origin', redirect: 'error', cache: 'no-store',
  }))
})

it('shows a waiting message for a slow operation and clears its timer on unmount', async () => {
  const first = render(<ConnectionNotice />)
  expect(screen.queryByRole('status')).not.toBeInTheDocument()
  await act(async () => {
    await vi.advanceTimersByTimeAsync(5000)
  })
  expect(screen.getByRole('status')).toHaveTextContent(
    'taking a moment to wake up',
  )
  first.unmount()
  const second = render(<ConnectionNotice />)
  second.unmount()
  await act(async () => {
    await vi.runAllTimersAsync()
  })
  expect(screen.queryByRole('status')).not.toBeInTheDocument()
})
