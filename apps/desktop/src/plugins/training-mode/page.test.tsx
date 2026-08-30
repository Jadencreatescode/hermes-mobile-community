import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { bindTrainingApi } from './api'
import { TrainingModePage } from './page'

afterEach(cleanup)

const draftResponse = {
  name: 'weekly-client-report',
  skill_md: '# Weekly Client Report\n\nReviewed draft.',
  draft_hash: 'a'.repeat(64),
  approval_phrase: `SAVE weekly-client-report ${'a'.repeat(64)}`,
  steps: [{ kind: 'note', value: 'Open the dashboard.' }]
}

function completeForm() {
  fireEvent.change(screen.getByLabelText('Skill name'), { target: { value: 'weekly-client-report' } })
  fireEvent.change(screen.getByLabelText('Training goal'), {
    target: { value: 'Prepare and verify the weekly client report.' }
  })
  fireEvent.change(screen.getByLabelText('Semantic steps, never typed values'), {
    target: { value: 'Open the dashboard.\nReview the completed week.\nExport the report.' }
  })
  fireEvent.click(screen.getByLabelText('I reviewed these steps.'))
  fireEvent.click(screen.getByLabelText('This draft contains no secrets.'))
  fireEvent.click(screen.getByLabelText('I understand this creates a skill only and does not run it.'))
}

describe('Training Mode page', () => {
  it('keeps draft generation gated until the task and three acknowledgements are complete', () => {
    render(<TrainingModePage profile="default" />)

    const preview = screen.getByRole('button', { name: 'Preview reviewed skill' }) as HTMLButtonElement
    expect(preview.disabled).toBe(true)
    expect(screen.getByText('Complete the task details and all three acknowledgements.')).toBeTruthy()

    completeForm()

    expect(preview.disabled).toBe(false)
  })

  it('saves only the server-generated draft after the exact hash-bound approval phrase', async () => {
    const rest = vi.fn(async (path: string) => {
      if (path === '/draft') {return draftResponse}

      if (path === '/approve') {
        return { saved: true, idempotent: false, name: draftResponse.name, draft_hash: draftResponse.draft_hash }
      }

      throw new Error(`Unexpected path ${path}`)
    })

    const unbind = bindTrainingApi(rest as never)

    try {
      render(<TrainingModePage profile="default" />)
      completeForm()
      fireEvent.click(screen.getByRole('button', { name: 'Preview reviewed skill' }))

      expect(await screen.findByText('Reviewed SKILL.md draft')).toBeTruthy()
      expect(screen.getByText(/Reviewed draft\./)).toBeTruthy()
      const phrase = screen.getByText(draftResponse.approval_phrase)
      expect(phrase.className).toContain('break-all')
      const save = screen.getByRole('button', { name: 'Save reviewed skill' }) as HTMLButtonElement
      expect(save.disabled).toBe(true)
      fireEvent.change(screen.getByLabelText('Exact hash-bound approval phrase'), {
        target: { value: draftResponse.approval_phrase }
      })
      expect(save.disabled).toBe(false)
      fireEvent.click(save)

      await waitFor(() => expect(rest).toHaveBeenCalledWith('/approve', expect.any(Object)))
      const calls = rest.mock.calls as unknown as Array<[string, { body?: Record<string, unknown> }]>
      const approveBody = calls.find(([path]) => path === '/approve')?.[1]?.body
      expect(approveBody).toMatchObject({
        name: 'weekly-client-report',
        draft_hash: draftResponse.draft_hash,
        approval: draftResponse.approval_phrase
      })
      expect(await screen.findByText(/was not executed or scheduled/i)).toBeTruthy()
    } finally {
      unbind()
    }
  })

  it('invalidates the server draft and approval when task input changes', async () => {
    const rest = vi.fn(async () => draftResponse)
    const unbind = bindTrainingApi(rest as never)

    try {
      render(<TrainingModePage profile="default" />)
      completeForm()
      fireEvent.click(screen.getByRole('button', { name: 'Preview reviewed skill' }))
      await screen.findByText('Reviewed SKILL.md draft')
      fireEvent.change(screen.getByLabelText('Training goal'), { target: { value: 'Changed goal' } })
      expect(screen.queryByText('Reviewed SKILL.md draft')).toBeNull()
    } finally {
      unbind()
    }
  })

  it('documents a future browser demonstration without running or observing one', () => {
    render(<TrainingModePage profile="default" />)

    expect(screen.getByLabelText('Include a guided remote browser demonstration step')).toBeTruthy()
    expect(screen.getByText(/does not open a browser, execute the task/i)).toBeTruthy()
    expect(screen.getByText(/other iPhone apps or Safari tabs/i)).toBeTruthy()
  })

  it('offers an in-memory coaching session that cannot call the backend or run the task', () => {
    const rest = vi.fn()
    const unbind = bindTrainingApi(rest as never)

    try {
      render(<TrainingModePage profile="default" />)
      fireEvent.click(screen.getByRole('button', { name: 'Start guided coaching' }))
      expect(screen.getByText('Guided coaching session')).toBeTruthy()
      expect(screen.getByText(/When should Hermes use this workflow/i)).toBeTruthy()
      fireEvent.change(screen.getByLabelText('Coaching answer'), {
        target: { value: 'When the weekly client report is due.' }
      })
      fireEvent.click(screen.getByRole('button', { name: 'Save answer and continue' }))
      expect(screen.getByText(/What is the first semantic action/i)).toBeTruthy()
      expect(rest).not.toHaveBeenCalled()
      expect(screen.getByText(/cannot call Hermes tools, open a browser, save a skill, or run the task/i)).toBeTruthy()
    } finally {
      unbind()
    }
  })
})
