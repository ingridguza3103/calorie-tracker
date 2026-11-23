import { beforeEach, expect, it, vi } from 'vitest'
import { createDiaryEntry, deleteDiaryEntry, loadDiary, parseServings, updateDiaryEntry } from './diary'
import { SessionExpiredError } from './profiles'
import { diaryDay, entry, json } from './test/diaryFixtures'

const date = '2026-11-23'
const saved = entry(date)
const payload = { id: saved.id, food_estimate_id: 1, entry_date: date, servings: 1 }
const update = { food_estimate_id: 1, entry_date: date, servings: 2, version: 1 }
const fetchMock = vi.fn<typeof fetch>()
const signal = () => new AbortController().signal

beforeEach(() => { fetchMock.mockReset(); vi.stubGlobal('fetch', fetchMock) })

it('loads an explicit date and sends private same-origin requests', async () => {
  fetchMock.mockResolvedValue(json(diaryDay(date, [saved])))
  expect(await loadDiary(date, signal())).toEqual(diaryDay(date, [saved]))
  expect(fetchMock).toHaveBeenCalledWith(window.location.origin + '/api/diary?date=2026-11-23', expect.objectContaining({
    credentials: 'same-origin', cache: 'no-store', mode: 'same-origin',
  }))
})
it('loads totals without targets when a plan is missing', async () => {
  fetchMock.mockResolvedValue(json(diaryDay(date, [], false)))
  expect((await loadDiary(date, signal())).targets).toBeNull()
})
it('adds and updates entries using their UUID and version, and verifies deletes', async () => {
  fetchMock.mockResolvedValueOnce(json(saved, 201)).mockResolvedValueOnce(json({ ...saved, version: 2 }))
    .mockResolvedValueOnce(new Response(null, { status: 204 }))
  expect(await createDiaryEntry(payload, signal())).toEqual(saved)
  expect((await updateDiaryEntry(saved.id, update, signal())).version).toBe(2)
  await deleteDiaryEntry(saved, signal())
  for (const [index, method, body] of [[0, 'POST', payload], [1, 'PUT', update]] as const)
    expect(fetchMock.mock.calls[index][1]).toMatchObject({ method, body: JSON.stringify(body),
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Protection': '1' } })
  expect(fetchMock.mock.calls[2][0]).toBe(window.location.origin + '/api/diary/entries/' + saved.id + '?version=1')
})
it.each([403, 404, 409, 422, 500])('surfaces HTTP %s without retrying mutations', async (status) => {
  fetchMock.mockResolvedValue(json({}, status))
  await expect(createDiaryEntry(payload, signal())).rejects.toMatchObject({ status })
  expect(fetchMock).toHaveBeenCalledTimes(1)
})
it.each(['load', 'create', 'update', 'delete'])('expires the session on %s 401', async (method) => {
  fetchMock.mockResolvedValue(json({}, 401))
  const requests = { load: () => loadDiary(date, signal()), create: () => createDiaryEntry(payload, signal()),
    update: () => updateDiaryEntry(saved.id, update, signal()), delete: () => deleteDiaryEntry(saved, signal()) }
  await expect(requests[method as keyof typeof requests]()).rejects.toBeInstanceOf(SessionExpiredError)
})
it.each([
  null, {}, { ...diaryDay(date), date: '2026-11-24' },
  { ...diaryDay(date), entries: [entry('2026-11-24')] },
  { ...diaryDay(date), entries: [{ ...saved, id: 'wrong' }] },
  { ...diaryDay(date), entries: [{ ...saved, entry_date: '2026-02-30' }] },
  { ...diaryDay(date), entries: [{ ...saved, servings: 0 }] },
  { ...diaryDay(date), entries: [{ ...saved, estimate: null }] },
  { ...diaryDay(date), entries: [{ ...saved, totals: { ...saved.totals, calories: 1.5 } }] },
  { ...diaryDay(date), entries: [{ ...saved, version: 0 }] },
  { ...diaryDay(date), entries: [{ ...saved, created_at: 'wrong' }] },
  { ...diaryDay(date), entries: [{ ...saved, updated_at: 'wrong' }] },
  { ...diaryDay(date), totals: { ...saved.totals, protein_g: -1 } },
  { ...diaryDay(date), targets: {} },
  { ...diaryDay(date), remaining_calories: null },
  { ...diaryDay(date), calorie_progress: -1 },
  { ...diaryDay(date, [], false), calorie_progress: 1 },
])('rejects an unusable diary response %#', async (body) => {
  fetchMock.mockResolvedValue(json(body))
  await expect(loadDiary(date, signal())).rejects.toThrow('could not read')
})
it('rejects malformed JSON for a diary read or uncertain save', async () => {
  fetchMock.mockImplementation(async () => new Response('bad', { status: 200 }))
  await expect(loadDiary(date, signal())).rejects.toThrow('could not read')
  await expect(createDiaryEntry(payload, signal())).rejects.toThrow('Retry the same save')
})
it.each([null, { ...saved, servings: 21 }, { ...saved, version: 1.5 }])('rejects unusable saved entries %#', async (body) => {
  fetchMock.mockResolvedValue(json(body))
  await expect(updateDiaryEntry(saved.id, update, signal())).rejects.toThrow('Retry the same save')
})
it.each([['0.01', 0.01], ['20', 20], ['1.25', 1.25], ['', null], ['0', null], ['20.01', null],
  ['-1', null], ['1.001', null], ['1e1', null], ['NaN', null], ['.5', null]])('parses servings %s', (value, expected) => {
  expect(parseServings(String(value))).toBe(expected)
})

it.each([
  '', '2026-2-1', '2026-02-30', '2026-11-23T00:00:00Z',
  'https://evil.example', '//evil.example', '../auth/logout',
  '2026-11-23&date=2026-11-24', '2026-11-23#fragment', '2026-11-23\n',
])('rejects an invalid or forged diary date before any request: %s', async (value) => {
  await expect(loadDiary(value, signal())).rejects.toThrow('valid diary date')
  expect(fetchMock).not.toHaveBeenCalled()
})
it.each(['2026-01-02', '2024-02-29'])('serializes the validated calendar date %s as a query value', async (value) => {
  fetchMock.mockResolvedValueOnce(json(diaryDay(value)))
  await loadDiary(value, signal())
  expect(fetchMock).toHaveBeenCalledWith(window.location.origin + '/api/diary?date=' + value, expect.anything())
})
it('rejects forged entry paths for updates and deletes before any request', async () => {
  await expect(updateDiaryEntry('../auth/logout', update, signal())).rejects.toThrow('Invalid API path')
  await expect(deleteDiaryEntry({ ...saved, id: '../auth/logout' }, signal())).rejects.toThrow('Invalid API path')
  expect(fetchMock).not.toHaveBeenCalled()
})
