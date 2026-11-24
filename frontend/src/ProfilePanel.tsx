import { useEffect, useRef, useState } from 'react'
import { accountErrorMessage } from './api'
import { OnboardingWizard } from './OnboardingWizard'
import { ConnectionNotice } from './ConnectionNotice'
import { PlanPanel } from './PlanPanel'
import { DiaryWorkspace } from './DiaryPanel'
import { currentWorkspacePage, useWorkspacePage } from './workspacePage'
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
  active,
}: Readonly<{ profile: Profile; onEdit: () => void; active: boolean }>) {
  const heading = useRef<HTMLHeadingElement>(null)
  useEffect(() => {
    if (active) heading.current?.focus()
  }, [active])
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
        Update these details when your weight, goal or usual activity changes.
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
  const { page, navigate } = useWorkspacePage()
  const [attempt, setAttempt] = useState(0)
  const [editing, setEditing] = useState(false)
  const [targetEdit, setTargetEdit] = useState<{ targetDate?: string } | null>(null)
  const [planRevision, setPlanRevision] = useState(0)
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
    const firstSetup = state.status === 'ready' && state.profile === null
    setSaving(true)
    setSaveError('')
    const controller = new AbortController()
    saveController.current = controller
    try {
      const profile = await saveProfile(data, controller.signal)
      if (!controller.signal.aborted) {
        setState({ status: 'ready', profile })
        setEditing(false)
        setPlanRevision((value) => value + 1)
        if (firstSetup || currentWorkspacePage() === 'profile') navigate('plan')
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

  function editProfile() {
    setSaveError('')
    setTargetEdit(null)
    setEditing(true)
    navigate('profile')
  }

  function editGoal(targetDate?: string) {
    editProfile()
    if (state.status === 'ready' && state.profile?.goal !== 'maintain') {
      setTargetEdit({ targetDate })
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
  const wizard = (
    <OnboardingWizard
      key={targetEdit ? 'target:' + (targetEdit.targetDate ?? '') : 'profile'}
      profile={state.profile}
      initialStep={targetEdit ? 'target' : 'goal'}
      targetDate={targetEdit?.targetDate}
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
  if (!state.profile) return wizard
  return (
    <div className="plan-workspace">
      <nav className="workspace-navigation" aria-label="Main navigation">
        {(['diary', 'plan', 'profile'] as const).map((item) => (
          <a key={item} href={'#' + item} aria-current={page === item ? 'page' : undefined}
            aria-disabled={saving || undefined} onClick={(event) => {
              event.preventDefault()
              if (!saving) navigate(item)
            }}>
            {{ diary: 'Diary', plan: 'Plan', profile: 'Profile' }[item]}
          </a>
        ))}
      </nav>
      <section className="workspace-page" aria-label="Diary page" hidden={page !== 'diary'}>
        <DiaryWorkspace revision={planRevision} onSessionExpired={onSessionExpired}
          onPlanRequested={() => navigate('plan')} visible={page === 'diary'} />
      </section>
      <section className="workspace-page" aria-label="Plan page" hidden={page !== 'plan'}>
        <PlanPanel profile={state.profile} onSessionExpired={onSessionExpired} onEdit={editGoal} onReviewProfile={editProfile}
          onPlanChanged={() => setPlanRevision((value) => value + 1)} onOpenDiary={() => navigate('diary')}
          visible={page === 'plan'} />
      </section>
      <section className="workspace-page" aria-label="Profile page" hidden={page !== 'profile'}>
        {editing ? wizard : <ProfileSummary profile={state.profile} onEdit={editProfile} active={page === 'profile'} />}
      </section>
    </div>
  )
}
