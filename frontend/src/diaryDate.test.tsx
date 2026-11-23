import { act, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { formatDay, isCalendarDate, localDay, useDiaryDate } from './diaryDate'

afterEach(() => vi.useRealTimers())
function Dates() {
  const dates = useDiaryDate()
  return <><p>{dates.selected}</p><span>{dates.today}</span>
    <button onClick={() => dates.select('2020-02-29')}>Earlier</button>
    <button onClick={() => dates.select('bad')}>Invalid</button>
    <button onClick={dates.showToday}>Today</button></>
}
it('uses local calendar fields, including days different from UTC', () => {
  const value = new Date('2026-11-23T23:30:00Z')
  vi.spyOn(value, 'getFullYear').mockReturnValue(2026)
  vi.spyOn(value, 'getMonth').mockReturnValue(10)
  vi.spyOn(value, 'getDate').mockReturnValue(24)
  expect(localDay(value)).toBe('2026-11-24')
  expect(localDay(new Date(2026, 0, 2, 23, 45))).toBe('2026-01-02')
})
it.each([['2024-02-29', true], ['2026-02-29', false], ['2026-2-1', false],
  ['9999-99-99', false], [null, false]])('validates calendar date %s', (date, expected) => {
  expect(isCalendarDate(date)).toBe(expected)
})
it('formats the selected date without timezone shifting', () => {
  expect(formatDay('2026-11-23')).toBe(new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium', timeZone: 'UTC',
  }).format(new Date('2026-11-23T00:00:00Z')))
})
it('advances today at local midnight but preserves a chosen historical day', () => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date(2026, 10, 23, 23, 59, 50))
  const view = render(<Dates />)
  act(() => vi.advanceTimersByTime(30_000))
  expect(screen.getByText('2026-11-24', { selector: 'p' })).toBeInTheDocument()
  act(() => screen.getByText('Earlier').click())
  vi.setSystemTime(new Date(2026, 10, 25, 10))
  act(() => window.dispatchEvent(new Event('focus')))
  expect(screen.getByText('2020-02-29')).toBeInTheDocument()
  expect(screen.getByText('2026-11-25')).toBeInTheDocument()
  act(() => screen.getByText('Invalid').click())
  expect(screen.getByText('2020-02-29')).toBeInTheDocument()
  act(() => screen.getByText('Today').click())
  expect(screen.getByText('2026-11-25', { selector: 'p' })).toBeInTheDocument()
  act(() => document.dispatchEvent(new Event('visibilitychange')))
  view.unmount()
  expect(vi.getTimerCount()).toBe(0)
})
