import type { DiaryDay, DiaryEntry } from '../diary'
import type { FoodEstimate } from '../foods'

export const apple: FoodEstimate = {
  id: 1, description: 'apple', model: 'test-model', estimated_at: '2026-11-23T12:00:00Z',
  food: {
    name: 'Medium apple', serving_description: 'One medium raw apple.',
    estimated_weight_g: 182, calories: 95, protein_g: 0.5, carbohydrate_g: 25.1, fat_g: 0.3, fiber_g: 4.4,
    serving_assumptions: ['Assumed: one medium apple.'], cooking_assumptions: ['Assumed: raw, no added fat.'],
  },
}
export const targets = { daily_calories: 2000, calorie_adjustment: 0, protein_g: 120, carbohydrate_g: 230, fat_g: 67, fiber_g: 28 }
export function entry(date: string, changes: Partial<DiaryEntry> = {}): DiaryEntry {
  return {
    id: 'daab1898-b871-4895-b395-98838fd82525', entry_date: date, servings: 1, estimate: apple,
    totals: { calories: 95, protein_g: 0.5, carbohydrate_g: 25.1, fat_g: 0.3, fiber_g: 4.4 },
    version: 1, created_at: '2026-11-23T12:00:00Z', updated_at: '2026-11-23T12:00:00Z', ...changes,
  }
}
export function diaryDay(date: string, entries: DiaryEntry[] = [], withTargets = true): DiaryDay {
  const totals = entries.reduce((acc, item) => ({
    calories: acc.calories + item.totals.calories,
    protein_g: Number((acc.protein_g + item.totals.protein_g).toFixed(1)),
    carbohydrate_g: Number((acc.carbohydrate_g + item.totals.carbohydrate_g).toFixed(1)),
    fat_g: Number((acc.fat_g + item.totals.fat_g).toFixed(1)),
    fiber_g: Number((acc.fiber_g + item.totals.fiber_g).toFixed(1)),
  }), { calories: 0, protein_g: 0, carbohydrate_g: 0, fat_g: 0, fiber_g: 0 })
  return { date, entries, totals, targets: withTargets ? targets : null,
    remaining_calories: withTargets ? targets.daily_calories - totals.calories : null,
    calorie_progress: withTargets ? Math.round(totals.calories / targets.daily_calories * 1000) / 10 : null }
}
export function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } })
}
