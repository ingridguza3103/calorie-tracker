export interface User {
  id: number
  username: string
}

export type AuthAction = 'login' | 'register'

export class AccountError extends Error {}

async function requireSuccess(response: Response): Promise<void> {
  if (response.ok) return

  const messages: Record<number, string> = {
    401: 'Incorrect username or password.',
    403: 'This request could not be verified. Refresh the page and try again.',
    409: 'That username is already taken. Please choose another.',
    422: 'Check your username and password, then try again.',
    429: 'Too many attempts. Please wait a minute and try again.',
  }
  throw new AccountError(
    messages[response.status] ?? 'Something went wrong. Please try again.',
  )
}

async function readUser(response: Response): Promise<User> {
  await requireSuccess(response)
  const data: unknown = await response.json()
  if (
    typeof data !== 'object' ||
    data === null ||
    !('id' in data) ||
    typeof data.id !== 'number' ||
    !('username' in data) ||
    typeof data.username !== 'string'
  ) {
    throw new AccountError('We could not load your account. Please try again.')
  }
  return { id: data.id, username: data.username }
}

export async function currentUser(signal?: AbortSignal): Promise<User | null> {
  const response = await apiRequest('/api/auth/me', { signal })
  if (response.status === 401) return null
  return readUser(response)
}

export async function authenticate(
  action: AuthAction,
  username: string,
  password: string,
): Promise<User> {
  const response = await apiRequest(`/api/auth/${action}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-CSRF-Protection': '1' },
    body: JSON.stringify({ username, password }),
  })
  return readUser(response)
}

export async function signOut(): Promise<void> {
  const response = await apiRequest('/api/auth/logout', {
    method: 'POST',
    headers: { 'X-CSRF-Protection': '1' },
  })
  await requireSuccess(response)
}

export function accountErrorMessage(error: unknown): string {
  if (error instanceof DOMException && error.name === 'TimeoutError') {
    return 'Your tracker is taking longer to respond. Please try again.'
  }
  return error instanceof AccountError
    ? error.message
    : 'Could not connect. Check your connection and try again.'
}
import { apiRequest } from './http'
