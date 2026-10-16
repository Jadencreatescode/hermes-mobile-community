import type { PluginRestOptions } from '@hermes/plugin-sdk'

import { type TrainingDraft, validateTrainingDraft } from './training'

type Rest = <T>(path: string, options?: PluginRestOptions) => Promise<T>

let rest: null | Rest = null

export interface TrainingDraftResponse {
  name: string
  skill_md: string
  draft_hash: string
  approval_phrase: string
  steps: Array<{ kind: string; value: string }>
}

function requestBody(value: TrainingDraft) {
  const draft = validateTrainingDraft(value)

  const steps = draft.steps
    .split(/\r?\n/)
    .map(row => row.trim())
    .filter(Boolean)
    .map(note => ({ kind: 'note' as const, note }))

  if (draft.demonstration) {
    steps.unshift({
      kind: 'note',
      note: 'A user-guided remote Hermes browser demonstration may occur only after the user approves its scope.'
    })
  }

  return { name: draft.name, trigger: draft.goal, steps }
}

export function bindTrainingApi(next: Rest): () => void {
  rest = next

  return () => {
    if (rest === next) {
      rest = null
    }
  }
}

function api(): Rest {
  if (!rest) {
    throw new Error('Training Mode API is unavailable. Update Hermes and try again.')
  }

  return rest
}

export function draftTraining(value: TrainingDraft): Promise<TrainingDraftResponse> {
  return api()<TrainingDraftResponse>('/draft', { method: 'POST', body: requestBody(value) })
}

export function approveTraining(
  value: TrainingDraft,
  draft: TrainingDraftResponse,
  approval: string
): Promise<{ saved: boolean; idempotent: boolean; name: string; draft_hash: string }> {
  return api()('/approve', {
    method: 'POST',
    body: {
      ...requestBody(value),
      draft_hash: draft.draft_hash,
      approval
    }
  })
}
