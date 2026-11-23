import { AccountError } from './api'
import { apiRequest } from './http'
import { goalLabels, SessionExpiredError } from './profiles'
import type { Goal } from './profiles'

export interface CaloriePlan {
  version: 1
  goal: Goal
  current_weight_kg: number
  target_weight_kg: number | null
  target_date: string | null
  timeline_days: number | null
  weekly_change_kg: number
  maintenance: {
    maintenance_calories: number
    activity: { summary: string; assumptions: string[] }
    assumptions: string[]
  }
  targets: {
    daily_calories: number
    calorie_adjustment: number
    protein_g: number
    carbohydrate_g: number
    fat_g: number
    fiber_g: number
  }
  assumptions: string[]
}

export class PlanError extends AccountError {
  readonly status: number
  readonly suggestedDate: string | null

  constructor(
    message: string,
    status: number,
    suggestedDate: string | null = null,
  ) {
    super(message)
    this.status = status
    this.suggestedDate = suggestedDate
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function positive(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
}

function texts(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string')
}

function dateOrNull(value: unknown): value is string | null {
  if (value === null) return true
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const parsed = new Date(value + 'T00:00:00Z')
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value
}

function validTargets(value: unknown): value is CaloriePlan['targets'] {
  if (!record(value)) return false
  return ['daily_calories', 'protein_g', 'carbohydrate_g', 'fat_g', 'fiber_g'].every(
    (key) => positive(value[key]),
  ) && typeof value.calorie_adjustment === 'number' && Number.isFinite(value.calorie_adjustment)
}

function validMaintenance(value: unknown): value is CaloriePlan['maintenance'] {
  return record(value) && positive(value.maintenance_calories) && texts(value.assumptions) &&
    record(value.activity) && typeof value.activity.summary === 'string' && texts(value.activity.assumptions)
}

function isPlan(value: unknown): value is CaloriePlan {
  if (!record(value)) return false
  return value.version === 1 && typeof value.goal === 'string' && Object.hasOwn(goalLabels, value.goal) &&
    positive(value.current_weight_kg) && (value.target_weight_kg === null || positive(value.target_weight_kg)) &&
    dateOrNull(value.target_date) && (value.timeline_days === null || positive(value.timeline_days)) &&
    typeof value.weekly_change_kg === 'number' && Number.isFinite(value.weekly_change_kg) &&
    validTargets(value.targets) && validMaintenance(value.maintenance) && texts(value.assumptions)
}

async function requirePlanSuccess(response: Response): Promise<void> {
  if (response.ok) return
  if (response.status === 401) throw new SessionExpiredError('Please log in again.')
  if (response.status === 422) {
    const body: unknown = await response.json().catch(() => null)
    if (record(body) && record(body.detail) && typeof body.detail.message === 'string') {
      const suggestion = body.detail.suggested_target_date
      throw new PlanError(body.detail.message, 422, dateOrNull(suggestion) ? suggestion : null)
    }
  }
  const messages: Record<number, string> = {
    403: 'This request could not be verified. Refresh the page and try again.',
    409: 'Your profile changed or needs updating. Refresh the page and review your goal.',
    422: 'Review your profile and target date before creating a plan.',
    429: 'Too many AI requests, or the AI quota has been reached. Please try again later.',
    502: 'The AI response could not be used. Please try creating your plan again.',
    503: 'AI estimates are temporarily unavailable. Please try again later.',
    504: 'The AI estimate took too long. Please try creating your plan again.',
  }
  let message = messages[response.status] ?? 'Could not load or create your plan. Please try again.'
  const wait = Number(response.headers.get('Retry-After'))
  if (response.status === 429 && Number.isFinite(wait) && wait > 0 && wait <= 86400)
    message += ` Wait at least ${Math.ceil(wait)} seconds before retrying.`
  throw new PlanError(message, response.status)
}

async function readPlan(response: Response): Promise<CaloriePlan> {
  await requirePlanSuccess(response)
  const data: unknown = await response.json().catch(() => null)
  if (!isPlan(data)) throw new AccountError('We could not read your plan. Please try again.')
  return data
}

export async function loadPlan(signal: AbortSignal): Promise<CaloriePlan | null> {
  const response = await apiRequest('/api/plan', { signal })
  if (response.status === 404) return null
  return readPlan(response)
}

export async function createPlan(signal: AbortSignal): Promise<CaloriePlan> {
  return readPlan(await apiRequest('/api/plan', {
    method: 'POST', signal,
    headers: { 'Content-Type': 'application/json', 'X-CSRF-Protection': '1' },
    body: '{}',
  }))
}
