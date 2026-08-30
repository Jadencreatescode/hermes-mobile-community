import { Button, Codicon, host, Input, Textarea } from '@hermes/plugin-sdk'
import { useEffect, useMemo, useState } from 'react'

import { approveTraining, draftTraining, type TrainingDraftResponse } from './api'
import { type TrainingDraft } from './training'

interface TrainingModePageProps {
  profile?: string
}

const COACHING_QUESTIONS = [
  'When should Hermes use this workflow?',
  'What is the first semantic action Hermes should take?',
  'What visible result proves the task is complete?',
  'What condition should make Hermes stop and ask you?'
]

function ChecklistRow({
  checked,
  label,
  onChange
}: {
  checked: boolean
  label: string
  onChange: (checked: boolean) => void
}) {
  return (
    <label className="flex min-h-11 cursor-pointer items-center gap-3 rounded-lg border border-(--ui-stroke-secondary) px-3 py-2 text-sm">
      <input
        checked={checked}
        className="size-5 accent-(--ui-accent)"
        onChange={event => onChange(event.currentTarget.checked)}
        type="checkbox"
      />
      <span>{label}</span>
    </label>
  )
}

export function TrainingModePage({ profile }: TrainingModePageProps) {
  const selectedProfile = profile ?? String(host.state.profile.get?.() || 'default')
  const [name, setName] = useState('')
  const [goal, setGoal] = useState('')
  const [steps, setSteps] = useState('')
  const [demonstration, setDemonstration] = useState(false)
  const [reviewed, setReviewed] = useState(false)
  const [secretFree, setSecretFree] = useState(false)
  const [draftOnly, setDraftOnly] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [serverDraft, setServerDraft] = useState<TrainingDraftResponse | null>(null)
  const [approval, setApproval] = useState('')
  const [saved, setSaved] = useState(false)
  const [coaching, setCoaching] = useState(false)
  const [coachingIndex, setCoachingIndex] = useState(0)
  const [coachingAnswer, setCoachingAnswer] = useState('')

  const draft = useMemo<TrainingDraft>(
    () => ({ name, goal, steps, demonstration }),
    [demonstration, goal, name, steps]
  )

  const ready = Boolean(name.trim() && goal.trim() && steps.trim() && reviewed && secretFree && draftOnly)
  const preview = serverDraft?.skill_md ?? ''
  const approvalPhrase = serverDraft?.approval_phrase ?? ''

  useEffect(() => {
    setServerDraft(null)
    setApproval('')
    setSaved(false)
  }, [demonstration, goal, name, steps])

  const previewSkill = async () => {
    if (!ready || busy) {
      return
    }

    setBusy(true)
    setError('')

    try {
      setServerDraft(await draftTraining(draft))
      setApproval('')
      setSaved(false)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The reviewed draft is invalid.')
    } finally {
      setBusy(false)
    }
  }

  const saveSkill = async () => {
    if (!serverDraft || approval !== approvalPhrase || busy) {
      return
    }

    setBusy(true)
    setError('')

    try {
      await approveTraining(draft, serverDraft, approval)
      setSaved(true)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The reviewed skill could not be saved.')
    } finally {
      setBusy(false)
    }
  }

  const saveCoachingAnswer = () => {
    const answer = coachingAnswer.trim()

    if (!answer) {
      return
    }

    if (coachingIndex === 0) {
      setGoal(answer)
    } else {
      const prefix = coachingIndex === 2 ? 'Verify' : coachingIndex === 3 ? 'Stop and ask if' : ''
      const line = prefix ? `${prefix} ${answer}` : answer
      setSteps(current => [current.trim(), line].filter(Boolean).join('\n'))
    }

    setCoachingAnswer('')

    if (coachingIndex + 1 >= COACHING_QUESTIONS.length) {
      setCoaching(false)
      setCoachingIndex(0)
    } else {
      setCoachingIndex(current => current + 1)
    }
  }

  return (
    <main className="h-full min-h-0 overflow-y-auto bg-background text-foreground">
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-5 px-4 pb-[calc(2rem+env(safe-area-inset-bottom))] pt-[calc(1rem+env(safe-area-inset-top))] sm:px-6">
        <header className="space-y-2">
          <div className="flex items-center gap-2">
            <Codicon name="mortar-board" size="1.25rem" />
            <h1 className="text-xl font-semibold">Training Mode</h1>
          </div>
          <p className="text-sm text-(--ui-text-secondary)">
            Turn reviewed task steps into a reusable Hermes skill without running the task.
          </p>
        </header>

        <section className="space-y-3 rounded-xl border border-(--ui-stroke-secondary) p-4">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <h2 className="text-sm font-semibold">Optional guided coaching</h2>
              <p className="text-xs text-(--ui-text-tertiary)">
                This local, in-memory session asks bounded planning questions. It cannot call Hermes tools, open a browser, save a skill, or run the task.
              </p>
            </div>
            <Button
              className="min-h-11 w-full sm:w-auto"
              onClick={() => {
                setCoaching(true)
                setCoachingIndex(0)
                setCoachingAnswer('')
              }}
              variant="secondary"
            >
              Start guided coaching
            </Button>
          </div>
          {coaching && (
            <div className="space-y-3 rounded-lg bg-(--ui-bg-chrome) p-3">
              <h3 className="text-sm font-semibold">Guided coaching session</h3>
              <p className="text-sm">{COACHING_QUESTIONS[coachingIndex]}</p>
              <div className="space-y-1.5">
                <label className="text-sm font-medium" htmlFor="training-coaching-answer">Coaching answer</label>
                <Textarea
                  id="training-coaching-answer"
                  maxLength={500}
                  onChange={event => setCoachingAnswer(event.currentTarget.value)}
                  rows={3}
                  value={coachingAnswer}
                />
              </div>
              <div className="flex flex-col gap-2 sm:flex-row">
                <Button
                  className="min-h-11 w-full sm:w-auto"
                  disabled={!coachingAnswer.trim()}
                  onClick={saveCoachingAnswer}
                >
                  Save answer and continue
                </Button>
                <Button
                  className="min-h-11 w-full sm:w-auto"
                  onClick={() => setCoaching(false)}
                  variant="secondary"
                >
                  End coaching
                </Button>
              </div>
            </div>
          )}
        </section>

        <section className="space-y-4 rounded-xl border border-(--ui-stroke-secondary) bg-(--ui-sidebar-surface-background) p-4">
          <div className="space-y-1.5">
            <label className="text-sm font-medium" htmlFor="training-name">Skill name</label>
            <Input
              autoCapitalize="none"
              id="training-name"
              maxLength={64}
              onChange={event => setName(event.currentTarget.value)}
              placeholder="weekly-client-report"
              spellCheck={false}
              value={name}
            />
            <p className="text-xs text-(--ui-text-tertiary)">Lowercase letters, numbers, hyphens, and underscores.</p>
          </div>

          <div className="space-y-1.5">
            <label className="text-sm font-medium" htmlFor="training-goal">Training goal</label>
            <Textarea
              id="training-goal"
              maxLength={2_000}
              onChange={event => setGoal(event.currentTarget.value)}
              placeholder="When should Hermes use this workflow, and what must it accomplish?"
              rows={3}
              value={goal}
            />
          </div>

          <div className="space-y-1.5">
            <label className="text-sm font-medium" htmlFor="training-steps">Semantic steps, never typed values</label>
            <Textarea
              id="training-steps"
              maxLength={10_000}
              onChange={event => setSteps(event.currentTarget.value)}
              placeholder="One semantic action per line. Describe targets and expected results, but never enter passwords, codes, cookies, tokens, or values typed into fields."
              rows={8}
              value={steps}
            />
          </div>

          <label className="flex min-h-11 cursor-pointer items-start gap-3 rounded-lg border border-(--ui-stroke-secondary) px-3 py-2 text-sm">
            <input
              aria-label="Include a guided remote browser demonstration step"
              checked={demonstration}
              className="mt-0.5 size-5 accent-(--ui-accent)"
              onChange={event => setDemonstration(event.currentTarget.checked)}
              type="checkbox"
            />
            <span>
              <strong className="block font-medium">Include a guided remote browser demonstration step</strong>
              <span className="block text-xs text-(--ui-text-tertiary)">
                This only documents the future demonstration boundary. Training Mode does not open a browser, execute the task, or observe other iPhone apps or Safari tabs.
              </span>
            </span>
          </label>
        </section>

        <section className="space-y-3 rounded-xl border border-(--ui-stroke-secondary) p-4">
          <h2 className="text-sm font-semibold">Approval boundary</h2>
          <ChecklistRow checked={reviewed} label="I reviewed these steps." onChange={setReviewed} />
          <ChecklistRow checked={secretFree} label="This draft contains no secrets." onChange={setSecretFree} />
          <ChecklistRow
            checked={draftOnly}
            label="I understand this creates a skill only and does not run it."
            onChange={setDraftOnly}
          />
          <p className="text-xs text-(--ui-text-tertiary)">
            The backend generates the canonical draft and binds the approval phrase to its SHA-256 hash. Editing any task input invalidates the preview and approval.
          </p>
        </section>

        {!ready && (
          <p className="text-sm text-(--ui-text-secondary)">
            Complete the task details and all three acknowledgements.
          </p>
        )}
        {error && <p className="text-sm text-destructive" role="alert">{error}</p>}
        <Button className="min-h-11 w-full sm:w-auto" disabled={!ready || busy} onClick={() => void previewSkill()}>
          {busy && !preview ? 'Building draft…' : 'Preview reviewed skill'}
        </Button>

        {preview && (
          <section className="space-y-3 rounded-xl border border-(--ui-stroke-secondary) p-4">
            <h2 className="text-sm font-semibold">Reviewed SKILL.md draft</h2>
            <pre className="max-h-80 overflow-auto whitespace-pre-wrap rounded-lg bg-(--ui-bg-chrome) p-3 text-xs">
              {preview}
            </pre>
            <p className="text-xs text-(--ui-text-tertiary)">
              Review every line. To save this exact draft, type <code className="break-all">{approvalPhrase}</code>.
            </p>
            <div className="space-y-1.5">
              <label className="text-sm font-medium" htmlFor="training-approval">Exact hash-bound approval phrase</label>
              <Input
                autoCapitalize="none"
                id="training-approval"
                onChange={event => setApproval(event.currentTarget.value)}
                spellCheck={false}
                value={approval}
              />
            </div>
            <Button
              className="min-h-11 w-full sm:w-auto"
              disabled={approval !== approvalPhrase || busy || saved}
              onClick={() => void saveSkill()}
            >
              {saved ? 'Skill saved' : 'Save reviewed skill'}
            </Button>
            {saved && (
              <p className="text-sm text-(--ui-text-secondary)">
                The reviewed skill is saved for profile <strong>{selectedProfile}</strong>. It was not executed or scheduled.
              </p>
            )}
          </section>
        )}
      </div>
    </main>
  )
}
