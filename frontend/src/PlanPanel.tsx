import { useEffect, useRef, useState } from 'react'
import { accountErrorMessage } from './api'
import { ConnectionNotice } from './ConnectionNotice'
import { createPlan, loadPlan, PlanError } from './plans'
import type { CaloriePlan } from './plans'
import { goalLabels, SessionExpiredError } from './profiles'
import type { Profile } from './profiles'

type PlanState =
  | { status: 'loading' | 'empty' | 'creating' }
  | { status: 'ready'; plan: CaloriePlan }
  | { status: 'error'; operation: 'load' | 'create'; error: unknown }

const number = new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 })

function dateLabel(date: string): string {
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeZone: 'UTC' })
    .format(new Date(`${date}T00:00:00Z`))
}

function PlanResult({ plan, visible }: Readonly<{ plan: CaloriePlan; visible: boolean }>) {
  const heading = useRef<HTMLHeadingElement>(null)
  useEffect(() => { if (visible) heading.current?.focus() }, [visible])
  const nutrients = [
    ['Protein', plan.targets.protein_g], ['Carbohydrates', plan.targets.carbohydrate_g],
    ['Fat', plan.targets.fat_g], ['Fiber', plan.targets.fiber_g],
  ] as const
  const assumptions = [...new Set([
    ...plan.assumptions, ...plan.maintenance.assumptions, ...plan.maintenance.activity.assumptions,
  ])]
  const adjustment = plan.targets.calorie_adjustment
  return (
    <>
      <div className="plan-heading">
        <div>
          <p className="eyebrow">A LITTLE DIRECTION</p>
          <h2 id="plan-heading" ref={heading} tabIndex={-1}>Your daily plan.</h2>
        </div>
        <span className="goal-badge">{goalLabels[plan.goal]}</span>
      </div>
      <p className="plan-calories">{number.format(plan.targets.daily_calories)} <span>kcal / day</span></p>
      <dl className="plan-balance">
        <div><dt>Estimated maintenance</dt><dd>{number.format(plan.maintenance.maintenance_calories)} kcal</dd></div>
        <div><dt>Daily adjustment</dt><dd>{adjustment > 0 ? '+' : ''}{number.format(adjustment)} kcal</dd></div>
      </dl>
      <dl className="plan-nutrients">
        {nutrients.map(([label, grams]) => (
          <div key={label}><dt>{label}</dt><dd>{number.format(grams)} <span>g</span></dd></div>
        ))}
      </dl>
      {plan.target_date !== null && plan.target_weight_kg !== null && (
        <p className="profile-intro">
          Working toward {number.format(plan.target_weight_kg)} kg by {dateLabel(plan.target_date)}.
          {' '}About {number.format(Math.abs(plan.weekly_change_kg))} kg per week, estimated.
        </p>
      )}
      <p className="profile-help">A starting point for your routine. Review these targets as your weight and activity change.</p>
      <details className="plan-details">
        <summary>How this was estimated</summary>
        <p>{plan.maintenance.activity.summary}</p>
        <ul>{assumptions.map((assumption) => <li key={assumption}>{assumption}</li>)}</ul>
      </details>
    </>
  )
}

type PlanPanelProps = Readonly<{
  profile: Profile; onEdit: () => void; onSessionExpired: () => void
  onPlanChanged?: () => void
  onOpenDiary?: () => void
  visible?: boolean
}>

export function PlanPanel(props: PlanPanelProps) {
  // A changed profile resets all local plan state and cancels pending requests.
  return <PlanPanelContent key={JSON.stringify(props.profile)} {...props} />
}

function PlanPanelContent({ profile, onEdit, onSessionExpired, onPlanChanged, onOpenDiary, visible = true }: PlanPanelProps) {
  const [state, setState] = useState<PlanState>({ status: 'loading' })
  const [attempt, setAttempt] = useState(0)
  const active = useRef<AbortController | null>(null)

  useEffect(() => {
    const controller = new AbortController()
    active.current = controller
    void loadPlan(controller.signal).then((plan) => {
      if (!controller.signal.aborted) setState(plan ? { status: 'ready', plan } : { status: 'empty' })
    }).catch((error: unknown) => {
      if (controller.signal.aborted) return
      if (error instanceof SessionExpiredError) onSessionExpired()
      else setState({ status: 'error', operation: 'load', error })
    })
    return () => { controller.abort(); active.current?.abort() }
  }, [profile, attempt, onSessionExpired])

  async function generate() {
    const controller = new AbortController()
    active.current = controller
    setState({ status: 'creating' })
    try {
      const plan = await createPlan(controller.signal)
      if (!controller.signal.aborted) {
        setState({ status: 'ready', plan })
        onPlanChanged?.()
      }
    } catch (error) {
      if (controller.signal.aborted) return
      if (error instanceof SessionExpiredError) onSessionExpired()
      else setState({ status: 'error', operation: 'create', error })
    }
  }

  if (state.status === 'ready') return (
    <section className="profile-card plan-card" aria-labelledby="plan-heading">
      <PlanResult plan={state.plan} visible={visible} />
      {onOpenDiary && <button type="button" className="button-primary" onClick={onOpenDiary}>Go to diary</button>}
    </section>
  )
  const blocked = state.status === 'error' && state.error instanceof PlanError && state.error.status === 422
  const suggestion = state.status === 'error' && state.error instanceof PlanError ? state.error.suggestedDate : null
  let buttonLabel = 'Create my plan'
  if (state.status === 'creating') buttonLabel = 'Creating plan…'
  else if (state.status === 'error' && state.operation === 'load') buttonLabel = 'Retry loading plan'
  return (
    <section className="profile-card plan-card" aria-label="Daily calorie plan" aria-busy={state.status === 'creating'}>
      <p className="eyebrow">YOUR NEXT SMALL STEP</p>
      <h2>Make room for your goal.</h2>
      {state.status === 'loading' && <p role="status">Loading your plan…</p>}
      {state.status === 'creating' && <p role="status">Building your plan…</p>}
      {(state.status === 'loading' || state.status === 'creating') && <ConnectionNotice />}
      {state.status === 'empty' && <>
        <p className="profile-intro">Use your saved goal and weekly activity to calculate your daily calorie and nutrient targets.</p>
        <p className="profile-help">Your activity description, gym frequency and steps are sent to our AI provider when you create a plan.</p>
      </>}
      {state.status === 'error' && <>
        <p className="form-error" role="alert">{accountErrorMessage(state.error)}</p>
        {suggestion && <p className="profile-intro">Suggested earliest date: <strong>{dateLabel(suggestion)}</strong>. This is an estimate; you can also choose a smaller goal.</p>}
      </>}
      {blocked ? <button type="button" className="button-primary" onClick={onEdit}>Adjust goal</button> : (
        <button type="button" className="button-primary"
          disabled={state.status === 'loading' || state.status === 'creating'}
          onClick={() => {
            if (state.status === 'error' && state.operation === 'load') {
              setState({ status: 'loading' })
              setAttempt((previous) => previous + 1)
            }
            else void generate()
          }}>
          {buttonLabel}
        </button>
      )}
    </section>
  )
}
