import { useCallback, useEffect, useRef, useState } from 'react'
import { accountErrorMessage } from './api'
import { ConnectionNotice } from './ConnectionNotice'
import { createDiaryEntry, deleteDiaryEntry, DiaryError, loadDiary, parseServings, updateDiaryEntry } from './diary'
import type { DiaryDay, DiaryEntry, NewEntry, UpdatedEntry } from './diary'
import { formatDay, isCalendarDate, useDiaryDate } from './diaryDate'
import { FoodPanel } from './FoodPanel'
import { estimateFood } from './foods'
import type { FoodEstimate } from './foods'
import { SessionExpiredError } from './profiles'

type SessionProps = Readonly<{ onSessionExpired: () => void }>
const number = new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 })
const nutrients = [
  ['Protein', 'protein_g'], ['Carbohydrates', 'carbohydrate_g'],
  ['Fat', 'fat_g'], ['Fiber', 'fiber_g'],
] as const

function DiaryProgress({ day, onPlanRequested }: Readonly<{ day: DiaryDay; onPlanRequested?: () => void }>) {
  const target = day.targets
  return (
    <section className="profile-card diary-progress" aria-labelledby="diary-progress-heading">
      <p className="eyebrow">YOUR DAY, A LITTLE CLEARER</p>
      <h2 id="diary-progress-heading">Daily progress.</h2>
      <p className="plan-calories">{number.format(day.totals.calories)} <span>kcal logged</span></p>
      {target && day.remaining_calories !== null && <div className="diary-calorie-progress">
        <progress aria-label="Daily calorie progress" max={target.daily_calories}
          value={Math.min(day.totals.calories, target.daily_calories)} />
        <p>{number.format(day.calorie_progress ?? 0)}% of your current daily target ({number.format(target.daily_calories)} kcal).</p>
        <p>{number.format(Math.abs(day.remaining_calories))} kcal {day.remaining_calories >= 0 ? 'remaining' : 'above your current target'}.</p>
      </div>}
      {!target && <p className="profile-help">Create a current calorie plan to see your progress against a target. You can keep logging food.</p>}
      {!target && onPlanRequested && <button type="button" className="button-secondary" onClick={onPlanRequested}>Create a plan</button>}
      <dl className="plan-nutrients diary-nutrients">
        {nutrients.map(([label, key]) => <div key={key}>
          <dt>{label}</dt><dd>{number.format(day.totals[key])} <span>g</span></dd>
          {target && <p className="profile-help">of {number.format(target[key])} g</p>}
          {target && <progress aria-label={label + ' progress'} max={target[key]} value={Math.min(day.totals[key], target[key])} />}
        </div>)}
      </dl>
      <p className="profile-help">Entries belong to the calendar date you choose. Targets use your current plan, including when you view an earlier day.</p>
    </section>
  )
}

type AddProps = SessionProps & Readonly<{
  estimate: FoodEstimate; date: string; onSaved: () => void; onLock: (locked: boolean) => void
}>
function AddToDiary({ estimate, date, onSaved, onLock, onSessionExpired }: AddProps) {
  const [servings, setServings] = useState('1')
  const [intent, setIntent] = useState<NewEntry | null>(null)
  const [busy, setBusy] = useState(false)
  const [added, setAdded] = useState(false)
  const [error, setError] = useState('')
  const active = useRef<AbortController | null>(null)
  const amount = useRef<HTMLInputElement>(null)
  useEffect(() => () => { active.current?.abort(); onLock(false) }, [onLock])

  async function save() {
    const quantity = parseServings(servings)
    if (quantity === null) {
      setError('Use 0.01–20 servings, with up to two decimal places.')
      amount.current?.focus()
      return
    }
    const data = intent ?? { id: crypto.randomUUID(), food_estimate_id: estimate.id, entry_date: date, servings: quantity }
    setIntent(data)
    setBusy(true)
    setError('')
    onLock(true)
    const controller = new AbortController()
    active.current = controller
    try {
      await createDiaryEntry(data, controller.signal)
      if (controller.signal.aborted) return
      setIntent(null)
      setAdded(true)
      onLock(false)
      onSaved()
    } catch (failure) {
      if (controller.signal.aborted) return
      if (failure instanceof SessionExpiredError) onSessionExpired()
      else {
        setError(accountErrorMessage(failure))
        if (failure instanceof DiaryError && failure.status < 500) {
          setIntent(null)
          onLock(false)
        }
      }
    } finally {
      if (!controller.signal.aborted) setBusy(false)
    }
  }
  return (
    <div className="diary-add">
      {added ? <div role="status">
        <p>Added to {formatDay(date)}.</p>
        <button type="button" className="button-secondary" onClick={() => { setAdded(false); setError('') }}>Add again</button>
      </div> : <form noValidate onSubmit={(event) => { event.preventDefault(); void save() }}>
        <div className="profile-field">
          <label htmlFor="diary-servings">Servings to log</label>
          <input id="diary-servings" ref={amount} type="number" inputMode="decimal" min="0.01" max="20" step="0.01"
            value={servings} disabled={busy || intent !== null} onChange={(event) => { setServings(event.target.value); setError('') }}
            aria-describedby="diary-servings-help" />
        </div>
        <p id="diary-servings-help" className="profile-help">1 logs the whole description; 0.5 logs half. Saving to {formatDay(date)}.</p>
        <button type="submit" className="button-primary" disabled={busy}>
          {busy ? 'Saving entry…' : intent ? 'Retry same save' : 'Add to diary'}
        </button>
      </form>}
      {error && <p role="alert" className="form-error">{error}</p>}
      {intent && !busy && <p className="profile-help">The save could have reached the server. Retry it to check without adding a duplicate.</p>}
    </div>
  )
}

type EntryProps = SessionProps & Readonly<{ entry: DiaryEntry; onChanged: () => void }>
function EntryCard({ entry, onChanged, onSessionExpired }: EntryProps) {
  const [editing, setEditing] = useState(false)
  const [description, setDescription] = useState(entry.estimate.description)
  const [date, setDate] = useState(entry.entry_date)
  const [servings, setServings] = useState(String(entry.servings))
  const [intent, setIntent] = useState<UpdatedEntry | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [conflict, setConflict] = useState(false)
  const active = useRef<AbortController | null>(null)
  const heading = useRef<HTMLHeadingElement>(null)
  useEffect(() => () => { active.current?.abort() }, [])
  const label = 'entry-' + entry.id

  function handleError(failure: unknown) {
    if (failure instanceof SessionExpiredError) onSessionExpired()
    else {
      setError(accountErrorMessage(failure))
      setConflict(failure instanceof DiaryError && (failure.status === 409 || failure.status === 404))
      if (failure instanceof DiaryError && failure.status < 500) setIntent(null)
    }
  }
  async function save() {
    const quantity = parseServings(servings)
    if (!description.trim() || description.trim().length > 2000 || quantity === null || !isCalendarDate(date)) {
      setError('Enter a food description, a valid date and 0.01–20 servings (up to two decimal places).')
      return
    }
    const controller = new AbortController()
    active.current = controller
    setBusy(true)
    setError('')
    try {
      let data = intent
      if (!data) {
        const food = description.trim() === entry.estimate.description
          ? entry.estimate : await estimateFood(description.trim(), controller.signal)
        if (controller.signal.aborted) return
        data = { food_estimate_id: food.id, entry_date: date, servings: quantity, version: entry.version }
        setIntent(data)
      }
      await updateDiaryEntry(entry.id, data, controller.signal)
      if (controller.signal.aborted) return
      setIntent(null)
      setEditing(false)
      onChanged()
    } catch (failure) {
      if (!controller.signal.aborted) handleError(failure)
    } finally {
      if (!controller.signal.aborted) setBusy(false)
    }
  }
  async function remove() {
    const controller = new AbortController()
    active.current = controller
    setBusy(true)
    setError('')
    try {
      await deleteDiaryEntry(entry, controller.signal)
      if (!controller.signal.aborted) onChanged()
    } catch (failure) {
      if (!controller.signal.aborted) handleError(failure)
    } finally {
      if (!controller.signal.aborted) setBusy(false)
    }
  }
  return (
    <li className="diary-entry" aria-labelledby={label}>
      <div className="diary-entry-heading">
        <div><h3 id={label} ref={heading} tabIndex={-1}>{entry.estimate.food.name}</h3>
          <p className="profile-help">{entry.estimate.description}</p></div>
        <p><strong>{number.format(entry.totals.calories)} kcal</strong></p>
      </div>
      <p className="profile-help">{number.format(entry.servings)} × the described serving</p>
      <p className="profile-help">{nutrients.map(([title, key]) => title + ' ' + number.format(entry.totals[key]) + ' g').join(' · ')}</p>
      <details className="plan-details">
        <summary>Serving and cooking assumptions</summary>
        <p>{entry.estimate.food.serving_description} — {number.format(entry.estimate.food.estimated_weight_g)} g per described serving.</p>
        <ul>{[...new Set([...entry.estimate.food.serving_assumptions, ...entry.estimate.food.cooking_assumptions])]
          .map((note) => <li key={note}>{note}</li>)}</ul>
      </details>
      {editing ? <form noValidate onSubmit={(event) => { event.preventDefault(); void save() }} aria-label={'Edit ' + entry.estimate.food.name}>
        <fieldset className="food-fields" disabled={busy || conflict}>
          <div className="profile-field"><label htmlFor={label + '-food'}>Edit food description</label>
            <textarea id={label + '-food'} rows={2} maxLength={2000} value={description} disabled={intent !== null}
              onChange={(event) => setDescription(event.target.value)} /></div>
          <div className="diary-edit-fields">
            <div className="profile-field"><label htmlFor={label + '-date'}>Entry date</label>
              <input id={label + '-date'} type="date" value={date} disabled={intent !== null}
                onChange={(event) => setDate(event.target.value)} /></div>
            <div className="profile-field"><label htmlFor={label + '-amount'}>Entry servings</label>
              <input id={label + '-amount'} type="number" inputMode="decimal" min="0.01" max="20" step="0.01"
                value={servings} disabled={intent !== null} onChange={(event) => setServings(event.target.value)} /></div>
          </div>
          <p className="profile-help">Changing the food description requests a new AI estimate. Changing servings or date uses the saved estimate.</p>
          <div className="diary-actions">
            <button className="button-primary" type="submit">{busy ? 'Saving changes…' : intent ? 'Retry changes' : 'Save changes'}</button>
            <button className="button-secondary" type="button" onClick={() => {
              setEditing(false); setDescription(entry.estimate.description); setDate(entry.entry_date)
              setServings(String(entry.servings)); setIntent(null); setError(''); heading.current?.focus(); onChanged()
            }}>Cancel editing</button>
          </div>
        </fieldset>
      </form> : <div className="diary-actions">
        <button type="button" className="button-secondary" disabled={busy || conflict} onClick={() => { setEditing(true); setError('') }}>Edit entry</button>
        <button type="button" className="button-secondary" disabled={busy || conflict} onClick={() => { void remove() }}>
          {busy ? 'Deleting entry…' : 'Delete entry'}</button>
      </div>}
      {error && <p role="alert" className="form-error">{error}</p>}
      {conflict && <button type="button" className="button-secondary" onClick={onChanged}>Reload diary</button>}
    </li>
  )
}

function DiaryDateControls({ date, today, onSelect }: Readonly<{
  date: string; today: string; onSelect: (date: string) => void
}>) {
  return <div className="diary-date-controls">
    <div className="profile-field"><label htmlFor="diary-date">Diary date</label>
      <input id="diary-date" type="date" value={date} onChange={(event) => onSelect(event.target.value)} /></div>
    <div className="diary-current-date"><span>Today</span><time dateTime={today}>{formatDay(today)}</time></div>
  </div>
}

function DiaryContent({ date, today, onSelect, onToday, revision, onSessionExpired, onPlanRequested, visible }: SessionProps & Readonly<{
  date: string; today: string; onSelect: (date: string) => void; onToday: () => void
  revision: number; onPlanRequested?: () => void; visible: boolean
}>) {
  const [read, setRead] = useState<{ day: DiaryDay | null; error: string; key: string } | null>(null)
  const [attempt, setAttempt] = useState(0)
  const [locked, setLocked] = useState(false)
  const key = date + ':' + revision + ':' + attempt
  const loading = read?.key !== key
  const day = read?.day?.date === date ? read.day : null
  const error = loading ? '' : read?.error ?? ''
  const refresh = useCallback(() => { setAttempt((value) => value + 1) }, [])
  useEffect(() => {
    const controller = new AbortController()
    void loadDiary(date, controller.signal).then((data) => {
      if (!controller.signal.aborted) setRead({ day: data, error: '', key })
    }).catch((failure: unknown) => {
      if (controller.signal.aborted) return
      if (failure instanceof SessionExpiredError) onSessionExpired()
      else setRead((current) => ({ day: current?.day?.date === date ? current.day : null, error: accountErrorMessage(failure), key }))
    })
    return () => controller.abort()
  }, [date, key, onSessionExpired])
  return (
    <>
      <div aria-busy={loading}>
        {loading && <><p role="status">Loading your diary…</p><ConnectionNotice /></>}
        {error && <div className="profile-card"><p role="alert" className="form-error">{error}</p>
          <button type="button" className="button-secondary" onClick={refresh}>Reload diary</button></div>}
        {day && <DiaryProgress day={day} onPlanRequested={onPlanRequested} />}
      </div>
      <div className="diary-logging-grid">
      <FoodPanel key={date} onSessionExpired={onSessionExpired} locked={locked} visible={visible} renderActions={(estimate) => (
        <AddToDiary key={estimate.id} estimate={estimate} date={date} onSaved={refresh} onLock={setLocked} onSessionExpired={onSessionExpired} />
      )} />
      <section className="profile-card diary-entries-card" aria-labelledby="diary-entries-heading" aria-busy={loading}>
        <div className="diary-heading"><h2 id="diary-entries-heading">Food diary.</h2>
          <DiaryDateControls date={date} today={today} onSelect={onSelect} /></div>
        <div className="diary-entry-toolbar">
          {date !== today && <button type="button" className="button-secondary" onClick={onToday}>Today</button>}
          <button type="button" className="button-secondary" disabled={loading} onClick={refresh}>Refresh diary</button>
        </div>
        {day && (day.entries.length === 0 ? <p>No food logged for this day yet.</p> : <ul className="diary-entries">
          {day.entries.map((entry) => <EntryCard key={entry.id + ':' + entry.version} entry={entry} onChanged={refresh} onSessionExpired={onSessionExpired} />)}
        </ul>)}
      </section>
      </div>
    </>
  )
}

export function DiaryWorkspace({ revision, onSessionExpired, onPlanRequested, visible = true }: SessionProps & Readonly<{
  revision: number; onPlanRequested?: () => void; visible?: boolean
}>) {
  const { selected, today, select, showToday } = useDiaryDate()
  return (
    <section className="diary-workspace" aria-label="Daily food diary">
      <DiaryContent date={selected} today={today} onSelect={select} onToday={showToday} revision={revision}
        onSessionExpired={onSessionExpired} onPlanRequested={onPlanRequested} visible={visible} />
    </section>
  )
}
