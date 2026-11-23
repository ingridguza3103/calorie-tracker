import { useEffect, useRef, useState } from 'react'
import { accountErrorMessage } from './api'
import { OnboardingWizard } from './OnboardingWizard'
import { ConnectionNotice } from './ConnectionNotice'
import {
  genderLabels,
  goalLabels,
  loadProfile,
  saveProfile,
  SessionExpiredError,
} from './profiles'
import type { Profile, ProfileInput } from './profiles'

type ProfileState =
  | { status: 'loading' }
  | { status: 'ready'; profile: Profile | null }
  | { status: 'error'; message: string }

function ProfileSummary({
  profile,
  onEdit,
}: Readonly<{ profile: Profile; onEdit: () => void }>) {
  const heading = useRef<HTMLHeadingElement>(null)
  useEffect(() => {
    heading.current?.focus()
  }, [])
  const stats = [
    ['Age', `${profile.age} years`],
    ['Height', `${profile.height_cm} cm`],
    ['Current weight', `${profile.current_weight_kg} kg`],
    ['Gender', genderLabels[profile.gender]],
    ['Gym sessions', `${profile.gym_sessions_per_week} per week`],
    ['Daily steps', profile.steps_per_day.toLocaleString()],
  ]
  return (
    <section className="profile-card" aria-labelledby="profile-heading">
      <p className="eyebrow">YOUR STARTING POINT</p>
      <div className="profile-summary-header">
        <div>
          <h2 id="profile-heading" ref={heading} tabIndex={-1}>
            Your profile is ready.
          </h2>
          <p className="profile-intro">
            Your goal and activity details are saved to your account.
          </p>
        </div>
        <span className="goal-badge">{goalLabels[profile.goal]}</span>
      </div>
      <dl className="profile-stats">
        {stats.map(([label, value]) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd>{value}</dd>
          </div>
        ))}
        {profile.target_weight_kg !== null && (
          <div>
            <dt>Target weight</dt>
            <dd>{profile.target_weight_kg} kg</dd>
          </div>
        )}
        {profile.target_date !== null && (
          <div>
            <dt>Target date</dt>
            <dd>
              {new Intl.DateTimeFormat(undefined, {
                dateStyle: 'medium',
                timeZone: 'UTC',
              }).format(new Date(`${profile.target_date}T00:00:00Z`))}
            </dd>
          </div>
        )}
      </dl>
      <h3 className="profile-activity-heading">Your usual week</h3>
      <p className="profile-activity">{profile.activity_description}</p>
      <p className="profile-help">
        Daily calorie targets and food logging are coming next.
      </p>
      <button type="button" className="button-secondary" onClick={onEdit}>
        Edit profile
      </button>
    </section>
  )
}

export function ProfilePanel({
  onSessionExpired,
}: Readonly<{ onSessionExpired: () => void }>) {
  const [state, setState] = useState<ProfileState>({ status: 'loading' })
  const [attempt, setAttempt] = useState(0)
  const [editing, setEditing] = useState(false)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState('')
  const saveController = useRef<AbortController | null>(null)

  useEffect(() => {
    const controller = new AbortController()
    void loadProfile(controller.signal)
      .then((profile) => {
        if (!controller.signal.aborted) setState({ status: 'ready', profile })
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return
        if (error instanceof SessionExpiredError) onSessionExpired()
        else setState({ status: 'error', message: accountErrorMessage(error) })
      })
    return () => {
      controller.abort()
      saveController.current?.abort()
    }
  }, [attempt, onSessionExpired])

  async function save(data: ProfileInput) {
    setSaving(true)
    setSaveError('')
    const controller = new AbortController()
    saveController.current = controller
    try {
      const profile = await saveProfile(data, controller.signal)
      if (!controller.signal.aborted) {
        setState({ status: 'ready', profile })
        setEditing(false)
      }
    } catch (error) {
      if (!controller.signal.aborted) {
        if (error instanceof SessionExpiredError) onSessionExpired()
        else setSaveError(accountErrorMessage(error))
      }
    } finally {
      if (!controller.signal.aborted) setSaving(false)
    }
  }

  if (state.status === 'loading')
    return (
      <section className="profile-card" aria-live="polite">
        <p role="status">Loading your profile…</p>
        <ConnectionNotice />
      </section>
    )
  if (state.status === 'error')
    return (
      <section className="profile-card">
        <h2>Let’s try that again.</h2>
        <p className="form-error" role="alert">
          {state.message}
        </p>
        <button
          type="button"
          className="button-secondary"
          onClick={() => {
            setState({ status: 'loading' })
            setAttempt((previous) => previous + 1)
          }}
        >
          Retry profile
        </button>
      </section>
    )
  if (state.profile && !editing)
    return (
      <ProfileSummary
        profile={state.profile}
        onEdit={() => {
          setSaveError('')
          setEditing(true)
        }}
      />
    )
  return (
    <OnboardingWizard
      profile={state.profile}
      saving={saving}
      saveError={saveError}
      onSave={(data) => {
        void save(data)
      }}
      onCancel={() => {
        setSaveError('')
        setEditing(false)
      }}
    />
  )
}
