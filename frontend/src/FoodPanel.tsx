import { useEffect, useRef, useState } from 'react'
import { accountErrorMessage } from './api'
import { ConnectionNotice } from './ConnectionNotice'
import { estimateFood, FoodError } from './foods'
import type { FoodEstimate } from './foods'
import { SessionExpiredError } from './profiles'

const number = new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 })
const examples = [
  ['Apple', 'apple'],
  ['Fried egg', 'fried egg'],
  ['Eggs with butter', '2 fried eggs cooked with 1 tablespoon of butter'],
] as const

function Assumptions({ title, notes }: Readonly<{ title: string; notes: string[] }>) {
  return (
    <div>
      <h4>{title}</h4>
      <ul>{[...new Set(notes)].map((note) => <li key={note}>{note}</li>)}</ul>
    </div>
  )
}

function FoodResult({ estimate }: Readonly<{ estimate: FoodEstimate }>) {
  const heading = useRef<HTMLHeadingElement>(null)
  useEffect(() => { heading.current?.focus() }, [])
  const { food } = estimate
  const nutrients = [
    ['Protein', food.protein_g], ['Carbohydrates', food.carbohydrate_g],
    ['Fat', food.fat_g], ['Fiber', food.fiber_g],
  ] as const
  return (
    <section className="food-result" aria-labelledby="food-result-heading">
      <p className="eyebrow">YOUR NUTRITION ESTIMATE</p>
      <h3 id="food-result-heading" ref={heading} tabIndex={-1}>{food.name}</h3>
      <p className="profile-intro">{food.serving_description}</p>
      <p className="plan-calories">{number.format(food.calories)} <span>kcal for this serving</span></p>
      <dl className="plan-nutrients">
        {nutrients.map(([label, grams]) => (
          <div key={label}><dt>{label}</dt><dd>{number.format(grams)} <span>g</span></dd></div>
        ))}
      </dl>
      <p className="profile-help">Estimated edible weight: {number.format(food.estimated_weight_g)} g. Totals include the whole described serving.</p>
      <div className="food-assumptions">
        <Assumptions title="Serving assumptions" notes={food.serving_assumptions} />
        <Assumptions title="Cooking assumptions" notes={food.cooking_assumptions} />
      </div>
      <p className="profile-help">An AI estimate. Check the serving and preparation notes, and add detail when they do not match your food.</p>
    </section>
  )
}

export function FoodPanel({ onSessionExpired }: Readonly<{ onSessionExpired: () => void }>) {
  const [description, setDescription] = useState('')
  const [result, setResult] = useState<FoodEstimate | null>(null)
  const [error, setError] = useState('')
  const [invalid, setInvalid] = useState(false)
  const [busy, setBusy] = useState(false)
  const controller = useRef<AbortController | null>(null)
  const input = useRef<HTMLTextAreaElement>(null)

  useEffect(() => () => { controller.current?.abort() }, [])

  function change(value: string) {
    setDescription(value)
    setResult(null)
    setError('')
    setInvalid(false)
  }

  async function submit() {
    const text = description.trim()
    if (!text || text.length > 2000) {
      setError('Describe your food in 1–2,000 characters.')
      setInvalid(true)
      input.current?.focus()
      return
    }
    const request = new AbortController()
    controller.current = request
    setBusy(true)
    setError('')
    setInvalid(false)
    setResult(null)
    try {
      const estimate = await estimateFood(text, request.signal)
      if (!request.signal.aborted) setResult(estimate)
    } catch (failure) {
      if (request.signal.aborted) return
      if (failure instanceof SessionExpiredError) onSessionExpired()
      else {
        setError(accountErrorMessage(failure))
        setInvalid(failure instanceof FoodError && failure.status === 422)
      }
    } finally {
      if (!request.signal.aborted) setBusy(false)
    }
  }

  return (
    <section className="profile-card plan-card food-card" aria-labelledby="food-heading">
      <p className="eyebrow">A LITTLE FOOD AWARENESS</p>
      <h2 id="food-heading">What’s on your plate?</h2>
      <p className="profile-intro">Describe a food or meal. Include amounts and cooking details when you know them.</p>
      <form noValidate onSubmit={(event) => { event.preventDefault(); void submit() }}>
        <fieldset className="food-fields" disabled={busy}>
          <div className="profile-field">
            <label htmlFor="food-description">Food description</label>
            <textarea id="food-description" ref={input} rows={3} value={description}
              onChange={(event) => change(event.target.value)}
              maxLength={2000} aria-invalid={invalid} aria-describedby="food-help"
              placeholder="For example: 2 fried eggs cooked with 1 tablespoon of butter" />
          </div>
          <p id="food-help" className="profile-help">{description.length}/2,000 characters. Missing serving or cooking details will be shown as assumptions.</p>
          <div className="food-examples" aria-label="Example food descriptions">
            {examples.map(([label, text]) => (
              <button key={label} type="button" className="button-secondary" onClick={() => change(text)}>{label}</button>
            ))}
          </div>
          <button type="submit" className="button-primary">{busy ? 'Estimating…' : 'Estimate nutrition'}</button>
        </fieldset>
      </form>
      <p className="profile-help">Your food description is sent to our AI provider when you request an estimate.</p>
      {busy && <><p role="status">Estimating your food…</p><ConnectionNotice /></>}
      {error && <p role="alert" className="form-error">{error}</p>}
      {result && <FoodResult estimate={result} />}
    </section>
  )
}
