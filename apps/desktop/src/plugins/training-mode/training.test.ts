import { describe, expect, it } from 'vitest'

import { validateTrainingDraft } from './training'

const validDraft = {
  name: 'weekly-client-report',
  goal: 'Prepare and verify the weekly client report.',
  steps: 'Open the reporting dashboard.\nSelect the completed week.\nExport and review the report.',
  demonstration: true
}

describe('public Training Mode input contract', () => {
  it('requires a bounded skill name, goal, and reviewed steps', () => {
    expect(() => validateTrainingDraft({ ...validDraft, name: 'Bad Name' })).toThrow(/lowercase/)
    expect(() => validateTrainingDraft({ ...validDraft, goal: ' ' })).toThrow(/goal/)
    expect(() => validateTrainingDraft({ ...validDraft, steps: ' ' })).toThrow(/step/)
    expect(() => validateTrainingDraft({ ...validDraft, goal: 'x'.repeat(2001) })).toThrow(/goal/)
    expect(validateTrainingDraft(validDraft)).toEqual(validDraft)
  })
})
