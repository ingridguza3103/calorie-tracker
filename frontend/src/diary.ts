import { AccountError } from './api'
import { isCalendarDate } from './diaryDate'
import { isFoodEstimate } from './foods'
import type { FoodEstimate } from './foods'
import { apiRequest } from './http'
import type { CaloriePlan } from './plans'
import { SessionExpiredError } from './profiles'

export interface DiaryTotals {
  calories: number
  protein_g: number
  carbohydrate_g: number
  fat_g: number
  fiber_g: number
}
export interface DiaryEntry {
  id: string
  entry_date: string
  servings: number
  estimate: FoodEstimate
  totals: DiaryTotals
  version: number
  created_at: string
  updated_at: string
}
export interface DiaryDay {
  date: string
  entries: DiaryEntry[]
  totals: DiaryTotals
  targets: CaloriePlan['targets'] | null
  remaining_calories: number | null
  calorie_progress: number | null
}
export interface EntryInput { food_estimate_id: number; entry_date: string; servings: number }
export interface NewEntry extends EntryInput { id: string }
export interface UpdatedEntry extends EntryInput { version: number }

export class DiaryError extends AccountError {
  readonly status: number
  constructor(message: string, status: number) {
    super(message)
    this.status = status
  }
}
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}
function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}
function totals(value: unknown): value is DiaryTotals {
  return record(value) && ['calories', 'protein_g', 'carbohydrate_g', 'fat_g', 'fiber_g']
    .every((key) => finite(value[key]) && value[key] >= 0) && Number.isInteger(value.calories)
}
function validEntry(value: unknown): value is DiaryEntry {
  return record(value) && typeof value.id === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value.id) &&
    isCalendarDate(value.entry_date) && finite(value.servings) && value.servings >= 0.01 && value.servings <= 20 &&
    isFoodEstimate(value.estimate) && totals(value.totals) &&
    finite(value.version) && Number.isInteger(value.version) && value.version >= 1 &&
    typeof value.created_at === 'string' && Number.isFinite(Date.parse(value.created_at)) &&
    typeof value.updated_at === 'string' && Number.isFinite(Date.parse(value.updated_at))
}
function targets(value: unknown): value is CaloriePlan['targets'] | null {
  return value === null || (record(value) &&
    ['daily_calories', 'protein_g', 'carbohydrate_g', 'fat_g', 'fiber_g']
      .every((key) => finite(value[key]) && value[key] > 0) && finite(value.calorie_adjustment))
}
function validDay(value: unknown, date: string): value is DiaryDay {
  if (!record(value) || value.date !== date || !Array.isArray(value.entries) ||
    !value.entries.every((entry) => validEntry(entry) && entry.entry_date === date) ||
    !totals(value.totals) || !targets(value.targets)) return false
  return value.targets === null
    ? value.remaining_calories === null && value.calorie_progress === null
    : finite(value.remaining_calories) && finite(value.calorie_progress) && value.calorie_progress >= 0
}
async function requireSuccess(response: Response) {
  if (response.ok) return
  if (response.status === 401) throw new SessionExpiredError('Please log in again.')
  const messages: Record<number, string> = {
    403: 'This request could not be verified. Refresh the page and try again.',
    404: 'This entry or food estimate is no longer available. Reload the diary.',
    409: 'This entry changed elsewhere or was deleted. Reload the diary before trying again.',
    422: 'Check the food, date and servings. Use 0.01–20 servings, with up to two decimal places.',
  }
  throw new DiaryError(messages[response.status] ?? 'The diary could not be updated. Try again.', response.status)
}
async function readEntry(response: Response): Promise<DiaryEntry> {
  await requireSuccess(response)
  const value: unknown = await response.json().catch(() => null)
  if (!validEntry(value)) throw new AccountError('We could not read the saved entry. Retry the same save.')
  return value
}
const headers = { 'Content-Type': 'application/json', 'X-CSRF-Protection': '1' }

export async function loadDiary(date: string, signal: AbortSignal): Promise<DiaryDay> {
  if (!isCalendarDate(date)) throw new AccountError('Choose a valid diary date.')
  // Rebuild the query from calendar numbers; raw form text never becomes a URL.
  const day = new Date(date + 'T00:00:00Z')
  const canonical = [
    String(day.getUTCFullYear()).padStart(4, '0'),
    String(day.getUTCMonth() + 1).padStart(2, '0'),
    String(day.getUTCDate()).padStart(2, '0'),
  ].join('-')
  const response = await apiRequest('/api/diary', { signal }, { date: canonical })
  await requireSuccess(response)
  const value: unknown = await response.json().catch(() => null)
  if (!validDay(value, date)) throw new AccountError('We could not read your diary. Please reload it.')
  return value
}
export async function createDiaryEntry(data: NewEntry, signal: AbortSignal): Promise<DiaryEntry> {
  return readEntry(await apiRequest('/api/diary/entries', {
    method: 'POST', signal, headers, body: JSON.stringify(data),
  }))
}
export async function updateDiaryEntry(id: string, data: UpdatedEntry, signal: AbortSignal): Promise<DiaryEntry> {
  return readEntry(await apiRequest('/api/diary/entries/' + id, {
    method: 'PUT', signal, headers, body: JSON.stringify(data),
  }))
}
export async function deleteDiaryEntry(entry: DiaryEntry, signal: AbortSignal): Promise<void> {
  await requireSuccess(await apiRequest('/api/diary/entries/' + entry.id, {
    method: 'DELETE', signal, headers,
  }, { version: String(entry.version) }))
}
export function parseServings(value: string): number | null {
  if (!/^\d+(?:\.\d{1,2})?$/.test(value)) return null
  const result = Number(value)
  return result >= 0.01 && result <= 20 ? result : null
}
