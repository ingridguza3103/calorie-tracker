import { useEffect, useState } from 'react'

export function localDay(value = new Date()): string {
  return [
    String(value.getFullYear()).padStart(4, '0'),
    String(value.getMonth() + 1).padStart(2, '0'),
    String(value.getDate()).padStart(2, '0'),
  ].join('-')
}

export function isCalendarDate(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const parsed = new Date(value + 'T00:00:00Z')
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value
}

export function formatDay(value: string): string {
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeZone: 'UTC' })
    .format(new Date(value + 'T00:00:00Z'))
}

export function useDiaryDate() {
  const [dates, setDates] = useState(() => {
    const today = localDay()
    return { today, selected: today }
  })
  useEffect(() => {
    function tick() {
      const next = localDay()
      setDates((current) => current.today === next ? current : {
        today: next, selected: current.selected === current.today ? next : current.selected,
      })
    }
    const timer = window.setInterval(tick, 30_000)
    window.addEventListener('focus', tick)
    document.addEventListener('visibilitychange', tick)
    return () => {
      window.clearInterval(timer)
      window.removeEventListener('focus', tick)
      document.removeEventListener('visibilitychange', tick)
    }
  }, [])
  function select(day: string) {
    if (isCalendarDate(day)) setDates((current) => ({ ...current, selected: day }))
  }
  function showToday() {
    const today = localDay()
    setDates({ today, selected: today })
  }
  return { ...dates, select, showToday }
}
