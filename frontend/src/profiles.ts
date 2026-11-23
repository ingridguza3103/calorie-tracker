import { AccountError, requestSignal } from './api'

export const goalLabels = {
  gain: 'Gain weight',
  lose: 'Lose weight',
  maintain: 'Maintain weight',
} as const

export const genderLabels = {
  female: 'Female',
  male: 'Male',
  other: 'Other',
  prefer_not_to_say: 'Prefer not to say',
} as const

export type Goal = keyof typeof goalLabels
export type Gender = keyof typeof genderLabels

export interface ProfileInput {
  goal: Goal
  age: number
  height_cm: number
  current_weight_kg: number
  gender: Gender
  activity_description: string
  gym_sessions_per_week: number
  steps_per_day: number
  target_weight_kg: number | null
  target_date: string | null
}

export interface Profile extends ProfileInput {
  created_at: string
  updated_at: string
}

export class SessionExpiredError extends AccountError {}

async function requireProfileSuccess(response: Response): Promise<void> {
  if (response.ok) return
  if (response.status === 401)
    throw new SessionExpiredError('Please log in again.')
  const messages: Record<number, string> = {
    403: 'This request could not be verified. Refresh the page and try again.',
    422: 'Check your profile details and future target date, then try again.',
    429: 'Too many requests. Please wait a moment and try again.',
  }
  throw new AccountError(
    messages[response.status] ??
      'Could not save or load your profile. Please try again.',
  )
}

function isProfile(data: unknown): data is Profile {
  if (typeof data !== 'object' || data === null) return false
  const fields = data as Record<string, unknown>
  const numericFields = [
    'age',
    'height_cm',
    'current_weight_kg',
    'gym_sessions_per_week',
    'steps_per_day',
  ]
  const stringFields = ['activity_description', 'created_at', 'updated_at']
  return (
    typeof fields.goal === 'string' &&
    Object.hasOwn(goalLabels, fields.goal) &&
    typeof fields.gender === 'string' &&
    Object.hasOwn(genderLabels, fields.gender) &&
    numericFields.every(
      (key) => typeof fields[key] === 'number' && Number.isFinite(fields[key]),
    ) &&
    stringFields.every((key) => typeof fields[key] === 'string') &&
    (fields.target_weight_kg === null ||
      (typeof fields.target_weight_kg === 'number' &&
        Number.isFinite(fields.target_weight_kg))) &&
    (fields.target_date === null ||
      (typeof fields.target_date === 'string' &&
        /^\d{4}-\d{2}-\d{2}$/.test(fields.target_date)))
  )
}

async function readProfile(response: Response): Promise<Profile> {
  await requireProfileSuccess(response)
  const data: unknown = await response.json()
  if (!isProfile(data))
    throw new AccountError('We could not read your profile. Please try again.')
  return data
}

export async function loadProfile(
  signal: AbortSignal,
): Promise<Profile | null> {
  const response = await fetch('/api/profile', {
    credentials: 'same-origin',
    cache: 'no-store',
    signal: requestSignal(signal),
  })
  if (response.status === 404) return null
  return readProfile(response)
}

export async function saveProfile(
  data: ProfileInput,
  signal: AbortSignal,
): Promise<Profile> {
  const response = await fetch('/api/profile', {
    method: 'PUT',
    credentials: 'same-origin',
    cache: 'no-store',
    signal: requestSignal(signal),
    headers: { 'Content-Type': 'application/json', 'X-CSRF-Protection': '1' },
    body: JSON.stringify(data),
  })
  return readProfile(response)
}
