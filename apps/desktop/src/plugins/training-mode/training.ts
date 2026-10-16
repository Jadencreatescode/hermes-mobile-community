export interface TrainingDraft {
  name: string
  goal: string
  steps: string
  demonstration: boolean
}

const NAME_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/

function boundedText(value: string, label: string, maximum: number): string {
  const normalized = String(value ?? '').trim()

  if (!normalized || normalized.length > maximum || normalized.includes('\0')) {
    throw new Error(`${label} is required and must be at most ${maximum} characters.`)
  }

  return normalized
}

export function validateTrainingDraft(value: TrainingDraft): TrainingDraft {
  const name = String(value.name ?? '').trim()

  if (!NAME_RE.test(name) || name === 'root' || name === 'profiles') {
    throw new Error('Skill name must be a lowercase Hermes identifier using letters, numbers, hyphens, or underscores.')
  }

  return {
    name,
    goal: boundedText(value.goal, 'Training goal', 2_000),
    steps: boundedText(value.steps, 'Training steps', 10_000),
    demonstration: Boolean(value.demonstration)
  }
}
