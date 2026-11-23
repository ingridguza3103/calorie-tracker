import { AccountError } from './api'
import { apiRequest } from './http'
import { SessionExpiredError } from './profiles'

export interface FoodNutrition {
  name: string
  serving_description: string
  estimated_weight_g: number
  calories: number
  protein_g: number
  carbohydrate_g: number
  fat_g: number
  fiber_g: number
  serving_assumptions: string[]
  cooking_assumptions: string[]
}

export interface FoodEstimate {
  id: number
  description: string
  food: FoodNutrition
  model: string
  estimated_at: string
}

export class FoodError extends AccountError {
  readonly status: number

  constructor(message: string, status: number) {
    super(message)
    this.status = status
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function notes(value: unknown): value is string[] {
  return Array.isArray(value) && value.length >= 1 && value.length <= 6 &&
    value.every((note) => typeof note === 'string' && note.trim().length > 0 && note.length <= 400)
}

function validFood(value: unknown): value is FoodNutrition {
  if (!record(value)) return false
  const amounts = ['calories', 'protein_g', 'carbohydrate_g', 'fat_g', 'fiber_g']
  return typeof value.name === 'string' && value.name.trim().length > 0 &&
    typeof value.serving_description === 'string' && value.serving_description.trim().length > 0 &&
    typeof value.estimated_weight_g === 'number' && Number.isFinite(value.estimated_weight_g) && value.estimated_weight_g > 0 &&
    amounts.every((field) => typeof value[field] === 'number' && Number.isFinite(value[field]) && value[field] >= 0) &&
    Number.isInteger(value.calories) && notes(value.serving_assumptions) && notes(value.cooking_assumptions)
}

export function isFoodEstimate(value: unknown): value is FoodEstimate {
  return record(value) && typeof value.id === 'number' && Number.isInteger(value.id) && value.id > 0 &&
    typeof value.description === 'string' && typeof value.model === 'string' &&
    typeof value.estimated_at === 'string' && Number.isFinite(Date.parse(value.estimated_at)) && validFood(value.food)
}

async function requireFoodSuccess(response: Response): Promise<void> {
  if (response.ok) return
  if (response.status === 401) throw new SessionExpiredError('Please log in again.')
  const messages: Record<number, string> = {
    403: 'This request could not be verified. Refresh the page and try again.',
    422: 'We could not identify a food or drink. Describe the food, serving and how it was prepared.',
    429: 'Too many estimates, or the AI quota has been reached. Please try again later.',
    502: 'The AI response could not be used. Please try estimating again.',
    503: 'Food estimates are temporarily unavailable. Please try again later.',
    504: 'The food estimate took too long. Please try again.',
  }
  let message = messages[response.status] ?? 'Could not estimate this food. Please try again.'
  const wait = Number(response.headers.get('Retry-After'))
  if (response.status === 429 && Number.isFinite(wait) && wait > 0 && wait <= 86400)
    message += ' Wait at least ' + Math.ceil(wait) + ' seconds before retrying.'
  throw new FoodError(message, response.status)
}

export async function estimateFood(description: string, signal: AbortSignal): Promise<FoodEstimate> {
  const response = await apiRequest('/api/food/estimate', {
    method: 'POST', signal,
    headers: { 'Content-Type': 'application/json', 'X-CSRF-Protection': '1' },
    body: JSON.stringify({ description }),
  })
  await requireFoodSuccess(response)
  const result: unknown = await response.json().catch(() => null)
  if (!isFoodEstimate(result)) throw new AccountError('We could not read the food estimate. Please try again.')
  return result
}
