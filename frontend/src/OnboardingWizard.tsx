import { useEffect, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { genderLabels, goalLabels } from './profiles'
import type { Gender, Goal, Profile, ProfileInput } from './profiles'
import { ConnectionNotice } from './ConnectionNotice'

type Step = 'goal' | 'details' | 'target'
type Draft = Omit<Record<keyof ProfileInput, string>, 'goal' | 'gender'> & {
  goal: Goal | ''
  gender: Gender | ''
}
type Errors = Partial<Record<keyof Draft, string>>

const stepLabels = {
  goal: 'Goal',
  details: 'Body & activity',
  target: 'Target & date',
}
const goalDetails = {
  gain: { symbol: '↗', description: 'Build toward a higher weight.' },
  lose: { symbol: '↘', description: 'Work toward a lower weight.' },
  maintain: { symbol: '→', description: 'Keep your current weight.' },
}

const bodyFields = [
  { key: 'age', label: 'Age (years)', min: 18, max: 120, whole: true },
  { key: 'height_cm', label: 'Height (cm)', min: 50, max: 300, whole: false },
  {
    key: 'current_weight_kg',
    label: 'Current weight (kg)',
    min: 20,
    max: 500,
    whole: false,
  },
  {
    key: 'gym_sessions_per_week',
    label: 'Gym sessions per week',
    min: 0,
    max: 21,
    whole: true,
  },
  {
    key: 'steps_per_day',
    label: 'Average daily steps',
    min: 0,
    max: 100000,
    whole: true,
  },
] as const

function initialDraft(profile: Profile | null): Draft {
  return {
    goal: profile?.goal ?? '',
    age: profile ? String(profile.age) : '',
    height_cm: profile ? String(profile.height_cm) : '',
    current_weight_kg: profile ? String(profile.current_weight_kg) : '',
    gender: profile?.gender ?? '',
    activity_description: profile?.activity_description ?? '',
    gym_sessions_per_week: profile ? String(profile.gym_sessions_per_week) : '',
    steps_per_day: profile ? String(profile.steps_per_day) : '',
    target_weight_kg:
      profile?.target_weight_kg == null ? '' : String(profile.target_weight_kg),
    target_date: profile?.target_date ?? '',
  }
}

function validateDetails(draft: Draft): Errors {
  const errors: Errors = {}
  for (const field of bodyFields) {
    const value = Number(draft[field.key])
    if (
      draft[field.key].trim() === '' ||
      !Number.isFinite(value) ||
      value < field.min ||
      value > field.max
    ) {
      errors[field.key] = `Enter a value from ${field.min} to ${field.max}.`
    } else if (field.whole && !Number.isInteger(value)) {
      errors[field.key] = 'Enter a whole number.'
    }
  }
  if (!draft.gender) errors.gender = 'Choose an option.'
  const description = draft.activity_description.trim()
  if (description.length === 0 || description.length > 2000) {
    errors.activity_description = 'Describe your week in 1–2,000 characters.'
  }
  return errors
}

function validateTarget(draft: Draft): Errors {
  const errors: Errors = {}
  const target = Number(draft.target_weight_kg)
  const current = Number(draft.current_weight_kg)
  if (
    draft.target_weight_kg.trim() === '' ||
    !Number.isFinite(target) ||
    target < 20 ||
    target > 500
  ) {
    errors.target_weight_kg = 'Enter a weight from 20 to 500 kg.'
  } else if (draft.goal === 'gain' && target <= current) {
    errors.target_weight_kg = 'Choose a target above your current weight.'
  } else if (draft.goal === 'lose' && target >= current) {
    errors.target_weight_kg = 'Choose a target below your current weight.'
  }
  if (
    !draft.target_date ||
    draft.target_date <= new Date().toISOString().slice(0, 10)
  ) {
    errors.target_date = 'Choose a date after today (UTC).'
  }
  return errors
}

function validateStep(step: Step, draft: Draft): Errors {
  if (step === 'goal')
    return draft.goal ? {} : { goal: 'Choose a goal to continue.' }
  if (step === 'details') return validateDetails(draft)
  return validateTarget(draft)
}

interface WizardProps {
  profile: Profile | null
  saving: boolean
  saveError: string
  onSave: (data: ProfileInput) => void
  onCancel: () => void
  initialStep?: 'goal' | 'target'
  targetDate?: string
}

export function OnboardingWizard({
  profile,
  saving,
  saveError,
  onSave,
  onCancel,
  initialStep = 'goal',
  targetDate,
}: Readonly<WizardProps>) {
  const [draft, setDraft] = useState(() => ({ ...initialDraft(profile),
    ...(targetDate ? { target_date: targetDate } : {}),
  }))
  const [step, setStep] = useState<Step>(() => profile && profile.goal !== 'maintain' ? initialStep : 'goal')
  const [errors, setErrors] = useState<Errors>({})
  const [minimumDate] = useState(() => {
    const tomorrow = new Date()
    tomorrow.setUTCDate(tomorrow.getUTCDate() + 1)
    return tomorrow.toISOString().slice(0, 10)
  })
  const form = useRef<HTMLFormElement>(null)
  const heading = useRef<HTMLHeadingElement>(null)
  const steps: Step[] =
    draft.goal === 'maintain'
      ? ['goal', 'details']
      : ['goal', 'details', 'target']
  const stepIndex = steps.indexOf(step)
  const finalStep = stepIndex === steps.length - 1
  const hasErrors = Object.keys(errors).length > 0
  let actionLabel = finalStep ? 'Save profile' : 'Continue'
  if (saving) actionLabel = 'Saving…'
  const titles = {
    goal: 'What’s your goal?',
    details: 'Tell us about you.',
    target: 'Where would you like to get?',
  }

  useEffect(() => {
    heading.current?.focus()
  }, [step])
  useEffect(() => {
    if (hasErrors)
      form.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus()
  }, [errors, hasErrors])

  function change(key: keyof Draft, value: string) {
    setDraft((previous) => ({ ...previous, [key]: value }))
    setErrors({})
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (saving) return
    const nextErrors = validateStep(step, draft)
    setErrors(nextErrors)
    if (Object.keys(nextErrors).length > 0) return
    if (!finalStep) {
      setStep(steps[stepIndex + 1])
      return
    }
    onSave({
      goal: draft.goal as Goal,
      age: Number(draft.age),
      height_cm: Number(draft.height_cm),
      current_weight_kg: Number(draft.current_weight_kg),
      gender: draft.gender as Gender,
      activity_description: draft.activity_description.trim(),
      gym_sessions_per_week: Number(draft.gym_sessions_per_week),
      steps_per_day: Number(draft.steps_per_day),
      target_weight_kg:
        draft.goal === 'maintain' ? null : Number(draft.target_weight_kg),
      target_date: draft.goal === 'maintain' ? null : draft.target_date,
    })
  }

  function numberField(field: (typeof bodyFields)[number]) {
    return (
      <div className="profile-field" key={field.key}>
        <label htmlFor={field.key}>{field.label}</label>
        <input
          id={field.key}
          name={field.key}
          type="number"
          required
          min={field.min}
          max={field.max}
          step={field.whole ? '1' : 'any'}
          inputMode={field.whole ? 'numeric' : 'decimal'}
          value={draft[field.key]}
          onChange={(event) => change(field.key, event.target.value)}
          aria-invalid={Boolean(errors[field.key])}
          aria-describedby={`${field.key}-error`}
        />
        <p className="field-error" id={`${field.key}-error`}>
          {errors[field.key]}
        </p>
      </div>
    )
  }

  return (
    <section className="profile-card" aria-labelledby="wizard-heading">
      <div className="wizard-progress">
        <p className="eyebrow">
          {profile ? 'EDIT YOUR PROFILE' : 'A STARTING POINT, JUST FOR YOU'}
        </p>
        <span>
          Step {stepIndex + 1} of {steps.length}
        </span>
      </div>
      <ol className="wizard-steps" aria-label="Profile setup steps">
        {steps.map((item, index) => (
          <li
            key={item}
            aria-current={item === step ? 'step' : undefined}
            data-complete={index < stepIndex}
          >
            <span aria-hidden="true">{index + 1}</span>
            {stepLabels[item]}
          </li>
        ))}
      </ol>
      <h2 id="wizard-heading" ref={heading} tabIndex={-1}>
        {titles[step]}
      </h2>
      <p className="profile-intro">
        {step === 'goal' && 'Choose the direction that feels right for you.'}
        {step === 'details' &&
          'A few details about you and your usual week. For adults aged 18 and over.'}
        {step === 'target' &&
          'Set your target weight and a date to work toward.'}
      </p>
      <form ref={form} onSubmit={submit} noValidate aria-busy={saving}>
        <fieldset className="wizard-fields" disabled={saving}>
          <legend className="sr-only">{titles[step]}</legend>
          {step === 'goal' && (
            <div
              className="goal-options"
              role="radiogroup"
              aria-label="Weight goal"
              aria-describedby="goal-error"
            >
              {(Object.entries(goalLabels) as [Goal, string][]).map(
                ([goal, label]) => (
                  <label
                    className="goal-option"
                    key={goal}
                    data-selected={draft.goal === goal}
                  >
                    <input
                      type="radio"
                      name="goal"
                      value={goal}
                      checked={draft.goal === goal}
                      onChange={() => change('goal', goal)}
                      aria-invalid={Boolean(errors.goal)}
                    />
                    <span className="goal-symbol" aria-hidden="true">
                      {goalDetails[goal].symbol}
                    </span>
                    <strong>{label}</strong>
                    <span className="goal-description">
                      {goalDetails[goal].description}
                    </span>
                  </label>
                ),
              )}
              <p className="field-error" id="goal-error">
                {errors.goal}
              </p>
            </div>
          )}
          {step === 'details' && (
            <>
              <div className="profile-grid">
                {bodyFields.slice(0, 3).map(numberField)}
                <div className="profile-field">
                  <label htmlFor="gender">Gender</label>
                  <select
                    id="gender"
                    name="gender"
                    value={draft.gender}
                    required
                    onChange={(event) => change('gender', event.target.value)}
                    aria-invalid={Boolean(errors.gender)}
                    aria-describedby="gender-error"
                  >
                    <option value="">Choose an option</option>
                    {Object.entries(genderLabels).map(([value, label]) => (
                      <option key={value} value={value}>
                        {label}
                      </option>
                    ))}
                  </select>
                  <p className="field-error" id="gender-error">
                    {errors.gender}
                  </p>
                </div>
              </div>
              <div className="profile-field">
                <label htmlFor="activity_description">Weekly activity</label>
                <textarea
                  id="activity_description"
                  name="activity_description"
                  rows={3}
                  required
                  maxLength={2000}
                  placeholder="For example: a desk job, gym twice a week, and evening walks."
                  value={draft.activity_description}
                  onChange={(event) =>
                    change('activity_description', event.target.value)
                  }
                  aria-invalid={Boolean(errors.activity_description)}
                  aria-describedby="activity-help activity-error"
                />
                <p className="profile-help" id="activity-help">
                  Include work, exercise, and walking. Your best estimate is
                  fine.
                </p>
                <p className="field-error" id="activity-error">
                  {errors.activity_description}
                </p>
              </div>
              <div className="profile-grid">
                {bodyFields.slice(3).map(numberField)}
              </div>
            </>
          )}
          {step === 'target' && (
            <div className="profile-grid">
              <div className="profile-field">
                <label htmlFor="target_weight_kg">Target weight (kg)</label>
                <input
                  id="target_weight_kg"
                  name="target_weight_kg"
                  type="number"
                  inputMode="decimal"
                  min={20}
                  max={500}
                  step="any"
                  required
                  value={draft.target_weight_kg}
                  onChange={(event) =>
                    change('target_weight_kg', event.target.value)
                  }
                  aria-invalid={Boolean(errors.target_weight_kg)}
                  aria-describedby="target_weight_kg-error"
                />
                <p className="field-error" id="target_weight_kg-error">
                  {errors.target_weight_kg}
                </p>
              </div>
              <div className="profile-field">
                <label htmlFor="target_date">Target date</label>
                <input
                  id="target_date"
                  name="target_date"
                  type="date"
                  min={minimumDate}
                  required
                  value={draft.target_date}
                  onChange={(event) =>
                    change('target_date', event.target.value)
                  }
                  aria-invalid={Boolean(errors.target_date)}
                  aria-describedby="target-date-help target_date-error"
                />
                <p className="profile-help" id="target-date-help">
                  Choose a date after today. Dates are checked in UTC.
                </p>
                <p className="field-error" id="target_date-error">
                  {errors.target_date}
                </p>
              </div>
            </div>
          )}
        </fieldset>
        {hasErrors && (
          <p className="form-error" role="alert">
            Please check the highlighted fields.
          </p>
        )}
        {saveError && (
          <p className="form-error" role="alert">
            {saveError}
          </p>
        )}
        {saving && (
          <p className="profile-help" role="status">
            Saving your profile…
          </p>
        )}
        {saving && <ConnectionNotice />}
        <div className="wizard-actions">
          <div className="wizard-back-actions">
            {step !== 'goal' && (
              <button
                type="button"
                className="button-secondary"
                disabled={saving}
                onClick={() => {
                  setErrors({})
                  setStep(steps[stepIndex - 1])
                }}
              >
                Back
              </button>
            )}
            {profile && (
              <button
                type="button"
                className="button-secondary"
                disabled={saving}
                onClick={onCancel}
              >
                Cancel
              </button>
            )}
          </div>
          <button type="submit" className="button-primary" disabled={saving}>
            {actionLabel}
            <span aria-hidden="true">↗</span>
          </button>
        </div>
      </form>
    </section>
  )
}
