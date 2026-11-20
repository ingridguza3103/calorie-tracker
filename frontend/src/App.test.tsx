import { act, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import App from './App'

const fetchMock = vi.fn<typeof fetch>()

const readyResponse = {
  status: 'ready',
  database: 'connected',
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

beforeEach(() => {
  fetchMock.mockReset()
  vi.stubGlobal('fetch', fetchMock)
})

describe('Connection status', () => {
  it('shows loading, then success, when the connection check passes', async () => {
    let finishRequest!: (response: Response) => void

    fetchMock.mockReturnValueOnce(
      new Promise<Response>((resolve) => {
        finishRequest = resolve
      }),
    )

    const user = userEvent.setup()
    render(<App />)

    expect(screen.getByRole('status')).toHaveTextContent(
      'Check that your services are ready.',
    )
    expect(fetchMock).not.toHaveBeenCalled()

    await user.click(
      screen.getByRole('button', { name: /check connection/i }),
    )

    expect(
      screen.getByRole('button', { name: /checking/i }),
    ).toBeDisabled()

    await act(async () => {
      finishRequest(jsonResponse(readyResponse))
    })

    expect(
      await screen.findByText('API and database connected.'),
    ).toBeInTheDocument()

    expect(
      screen.getByRole('button', { name: /check connection/i }),
    ).toBeEnabled()
  })

  it.each([
    {
      reason: 'an HTTP error',
      request: () => Promise.resolve(jsonResponse({}, 503)),
    },
    {
      reason: 'an unexpected readiness status',
      request: () =>
        Promise.resolve(
          jsonResponse({
            status: 'unavailable',
            database: 'connected',
          }),
        ),
    },
    {
      reason: 'a disconnected database',
      request: () =>
        Promise.resolve(
          jsonResponse({
            status: 'ready',
            database: 'disconnected',
          }),
        ),
    },
    {
      reason: 'invalid JSON',
      request: () => Promise.resolve(new Response('invalid JSON')),
    },
    {
      reason: 'a network failure',
      request: () => Promise.reject(new TypeError('Network unavailable')),
    },
  ])('shows an error after $reason and allows another check', async ({ request }) => {
    fetchMock.mockImplementationOnce(request)

    const user = userEvent.setup()
    render(<App />)

    await user.click(
      screen.getByRole('button', { name: /check connection/i }),
    )

    expect(
      await screen.findByText(
        'Connection unavailable. Check your backend and database.',
      ),
    ).toBeInTheDocument()

    expect(
      screen.getByRole('button', { name: /check connection/i }),
    ).toBeEnabled()
  })
})