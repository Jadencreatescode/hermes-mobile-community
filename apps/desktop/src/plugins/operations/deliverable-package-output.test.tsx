import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { bindOperationsApi } from './api'
import { outputDetailFromWire } from './deliverable-package'
import { DeliverablePackageOutput, reviewerCandidates } from './deliverable-package-output'
import { createMeetingDraft, type MeetingRecord } from './meetings'

const orchestrator = { connectionId: 'local', profile: 'orchestrator' }
const producer = { connectionId: 'local', profile: 'producer' }
const reviewer = { connectionId: 'local', profile: 'reviewer' }

let unbind: (() => void) | undefined

afterEach(() => {
  cleanup()
  unbind?.()
  unbind = undefined
  vi.restoreAllMocks()
})

function productionMeeting(): MeetingRecord {
  return createMeetingDraft({
    acceptanceStatement: 'A reviewer confirms every onboarding step is reproducible.',
    agenda: 'Produce and review the onboarding guide.',
    chair: orchestrator,
    id: 'meeting-production-1',
    maxRounds: 3,
    orchestrator,
    outputTitle: 'Onboarding guide',
    participants: [orchestrator, producer, reviewer],
    producer,
    productKind: 'document',
    seats: [
      { bot: orchestrator, role: 'specialist', label: 'Orchestrator' },
      { bot: producer, role: 'contributor', label: 'Producer' },
      { bot: reviewer, role: 'reviewer', label: 'Independent reviewer' }
    ],
    source: orchestrator,
    title: 'Ship the onboarding guide'
  })
}

const manifestFiles = [
  {
    path: 'index.txt',
    media_type: 'text/plain',
    role: 'primary',
    preview_policy: 'text',
    byte_size: 31,
    sha256: 'a'.repeat(64)
  },
  {
    path: 'page.html',
    media_type: 'text/html',
    role: 'support',
    preview_policy: 'download_only',
    byte_size: 64,
    sha256: 'e'.repeat(64)
  }
]

function versionWire(artifactVersion: number, parent: number | null = null) {
  return {
    output_id: 'mout_1',
    artifact_version: artifactVersion,
    schema_version: 1,
    runtime_version: '1',
    game_sha256: String(artifactVersion).repeat(64).slice(0, 64),
    manifest_sha256: 'b'.repeat(64),
    zip_sha256: 'c'.repeat(64),
    total_byte_size: 95,
    parent_artifact_version: parent,
    manifest: {
      product_kind: 'document',
      title: 'Onboarding guide',
      summary: 'A one-page guide.',
      primary_file: 'index.txt',
      files: manifestFiles
    },
    created_at: 1_800_000_000
  }
}

function detail(
  overrides: {
    state?: string
    eligibility?: Record<string, boolean>
    versions?: unknown[]
    reviews?: unknown[]
    findings?: unknown[]
    verified?: number
    approved?: number
    current?: number
  } = {}
) {
  return outputDetailFromWire({
    output: {
      output_id: 'mout_1',
      meeting_id: 'meeting-production-1',
      kind: 'deliverable_package_v1',
      product_kind: 'document',
      title: 'Onboarding guide',
      summary: 'A reviewer confirms every onboarding step is reproducible.',
      brief: 'Produce the guide.',
      brief_hash: 'd'.repeat(64),
      producer: { connection: 'local', profile: 'producer' },
      source_meeting_version: 3,
      current_artifact_version: overrides.current ?? 1,
      verified_artifact_version: overrides.verified ?? 0,
      approved_artifact_version: overrides.approved ?? 0,
      state: overrides.state ?? 'reviewing',
      version: 5,
      findings: overrides.findings ?? [],
      created_at: 1_800_000_000,
      updated_at: 1_800_000_100
    },
    eligibility: {
      produce: false,
      review: false,
      revise: false,
      approve: false,
      preview: true,
      download: true,
      ...(overrides.eligibility ?? {})
    },
    versions: overrides.versions ?? [versionWire(1)],
    reviews: overrides.reviews ?? []
  })
}

describe('DeliverablePackageOutput', () => {
  it('shows immutable versions, hashes, lineage, and the manifest', () => {
    render(
      <DeliverablePackageOutput
        detail={detail({ versions: [versionWire(1), versionWire(2, 1)], current: 2 })}
        meeting={productionMeeting()}
        meetingVersion={7}
      />
    )

    const panel = screen.getByTestId('deliverable-package-output')

    expect(within(panel).getByRole('button', { name: /Artifact version 1/ })).toBeTruthy()
    expect(within(panel).getByRole('button', { name: /Artifact version 2, revised from 1/ })).toBeTruthy()
    expect(screen.getByTestId('version-lineage').textContent).toContain('Revised from artifact version 1')
    expect(panel.textContent).toContain('game_sha256')
    expect(panel.textContent).toContain('manifest_sha256')
    expect(panel.textContent).toContain('zip_sha256')
    expect(panel.textContent).toContain('index.txt')
    expect(panel.textContent).toContain('page.html')
  })

  it('selects an older immutable version without losing its own hashes', async () => {
    render(
      <DeliverablePackageOutput
        detail={detail({ versions: [versionWire(1), versionWire(2, 1)], current: 2 })}
        meeting={productionMeeting()}
        meetingVersion={7}
      />
    )

    expect(screen.getByTestId('version-lineage').textContent).toContain('Revised from artifact version 1')
    fireEvent.click(screen.getByRole('button', { name: /Artifact version 1/ }))
    expect(screen.getByTestId('version-lineage').textContent).toContain('Lineage root')
  })

  it('never offers a hash field or an approver field', () => {
    render(
      <DeliverablePackageOutput
        detail={detail({ state: 'verified', verified: 1, eligibility: { approve: true } })}
        meeting={productionMeeting()}
        meetingVersion={7}
      />
    )

    for (const label of [
      /output id/i,
      /artifact version \(/i,
      /game sha/i,
      /manifest sha/i,
      /zip sha/i,
      /approved by/i,
      /approved at/i
    ]) {
      expect(screen.queryByLabelText(label)).toBeNull()
    }

    expect(screen.queryByPlaceholderText(/sha-256/i)).toBeNull()
    expect(screen.getByRole('button', { name: /Approve this artifact version/ })).toBeTruthy()
  })

  it('shows only the actions the server marks eligible', () => {
    const { unmount } = render(
      <DeliverablePackageOutput detail={detail()} meeting={productionMeeting()} meetingVersion={7} />
    )

    expect(screen.queryByRole('button', { name: /Start independent review/ })).toBeNull()
    expect(screen.queryByRole('button', { name: /Approve this artifact version/ })).toBeNull()
    expect(screen.queryByRole('button', { name: /Start a revision/ })).toBeNull()
    unmount()

    const { unmount: unmountEligible } = render(
      <DeliverablePackageOutput
        detail={detail({ eligibility: { review: true, revise: true, approve: true } })}
        meeting={productionMeeting()}
        meetingVersion={7}
        onReview={async () => 'Artifact version 1 verified.'}
        onRevise={async () => 'Artifact version 2 collected.'}
      />
    )

    expect(screen.getByRole('button', { name: /Start independent review/ })).toBeTruthy()
    expect(screen.getByRole('button', { name: /Start a revision/ })).toBeTruthy()
    expect(screen.getByRole('button', { name: /Approve this artifact version/ })).toBeTruthy()
    unmountEligible()

    // Server-eligible, but with no reachable revision dispatch in this view:
    // the action stays hidden instead of opening a run nothing can collect.
    render(
      <DeliverablePackageOutput
        detail={detail({ eligibility: { review: true, revise: true, approve: true } })}
        meeting={productionMeeting()}
        meetingVersion={7}
      />
    )

    expect(screen.queryByRole('button', { name: /Start a revision/ })).toBeNull()
    expect(screen.queryByRole('button', { name: /Start independent review/ })).toBeNull()
    expect(screen.getByRole('button', { name: /Approve this artifact version/ })).toBeTruthy()
  })

  it('runs the real revision dispatch through the provided callback', async () => {
    const onRevise = vi.fn(async () => 'Artifact version 2 collected.')
    const onChanged = vi.fn()

    render(
      <DeliverablePackageOutput
        detail={detail({ eligibility: { revise: true } })}
        meeting={productionMeeting()}
        meetingVersion={7}
        onChanged={onChanged}
        onRevise={onRevise}
      />
    )

    fireEvent.click(screen.getByRole('button', { name: /Start a revision/ }))

    await waitFor(() => expect(onChanged).toHaveBeenCalled())
    expect(onRevise).toHaveBeenCalledTimes(1)
    expect(screen.getByTestId('output-notice').textContent).toContain('Artifact version 2 collected.')
  })

  it('dispatches independent review through the provided reviewer callback', async () => {
    const onReview = vi.fn(async () => 'Artifact version 1 verified by the reviewer Bot.')
    const onChanged = vi.fn()

    render(
      <DeliverablePackageOutput
        detail={detail({ eligibility: { review: true } })}
        meeting={productionMeeting()}
        meetingVersion={7}
        onChanged={onChanged}
        onReview={onReview}
      />
    )

    fireEvent.click(screen.getByRole('button', { name: /Start independent review/ }))

    await waitFor(() => expect(onChanged).toHaveBeenCalled())
    expect(onReview).toHaveBeenCalledTimes(1)
    expect(screen.getByTestId('output-notice').textContent).toContain('verified by the reviewer Bot')
  })

  it('surfaces review-dispatch failures without authoring a verdict in the panel', async () => {
    const onReview = vi.fn(async () => {
      throw new Error('Deterministic checks failed: zip_digest')
    })

    render(
      <DeliverablePackageOutput
        detail={detail({ eligibility: { review: true } })}
        meeting={productionMeeting()}
        meetingVersion={7}
        onReview={onReview}
      />
    )

    fireEvent.click(screen.getByRole('button', { name: /Start independent review/ }))

    await waitFor(() =>
      expect(screen.getByTestId('output-error').textContent).toContain('Deterministic checks failed: zip_digest')
    )
  })

  it('resumes an open review only through the reviewer dispatch callback', async () => {
    const onReview = vi.fn(async () => 'The reviewer requested changes on artifact version 1.')
    render(
      <DeliverablePackageOutput
        detail={detail({
          reviews: [
            {
              request_id: 'mrev_1',
              artifact_version: 1,
              state: 'open',
              verdict: '',
              reviewer: { connection: 'local', profile: 'reviewer' },
              findings: [],
              checks: { ok: true, checks: {}, failed_checks: [] },
              created_at: 1
            }
          ]
        })}
        meeting={productionMeeting()}
        meetingVersion={7}
        onReview={onReview}
      />
    )

    expect(screen.queryByRole('button', { name: /Record a verified verdict/ })).toBeNull()
    expect(screen.queryByRole('button', { name: /Request changes/ })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /Resume independent review/ }))
    await waitFor(() => expect(onReview).toHaveBeenCalledTimes(1))
    expect(screen.getByTestId('output-notice').textContent).toContain('reviewer requested changes')
  })

  it('displays structured findings with their severity', () => {
    render(
      <DeliverablePackageOutput
        detail={detail({
          state: 'changes_requested',
          findings: [
            { severity: 'critical', code: 'unsafe_preview', detail: 'Inline script found.', path: 'page.html' }
          ]
        })}
        meeting={productionMeeting()}
        meetingVersion={7}
      />
    )

    const findings = screen.getByLabelText('Review findings')

    expect(findings.textContent).toContain('critical')
    expect(findings.textContent).toContain('unsafe_preview')
    expect(findings.textContent).toContain('Inline script found.')
    expect(findings.textContent).toContain('page.html')
  })

  it('approves by echoing the server verified version and hashes', async () => {
    const rest = vi
      .fn()
      .mockResolvedValueOnce({
        output: detail({ state: 'verified', verified: 1 }).output,
        eligibility: { approve: true },
        versions: [versionWire(1)],
        reviews: []
      })
      .mockResolvedValueOnce({
        output: detail({ state: 'approved', approved: 1, verified: 1 }).output,
        eligibility: { download: true },
        artifact_binding: { approved_by: 'Owner', artifact_version: 1 }
      })

    unbind = bindOperationsApi(rest as never)

    render(
      <DeliverablePackageOutput
        detail={detail({ state: 'verified', verified: 1, eligibility: { approve: true } })}
        meeting={productionMeeting()}
        meetingVersion={9}
      />
    )

    fireEvent.click(screen.getByRole('button', { name: /Approve this artifact version/ }))

    await waitFor(() => expect(rest).toHaveBeenCalledTimes(2))
    expect(rest.mock.calls[1][0]).toBe('/meeting-outputs/mout_1/approve')
    expect(rest.mock.calls[1][1].body).toEqual({
      meeting_id: 'meeting-production-1',
      expected_meeting_version: 9,
      expected_output_version: 5,
      artifact_version: 1,
      game_sha256: '1'.repeat(64),
      manifest_sha256: 'b'.repeat(64),
      zip_sha256: 'c'.repeat(64)
    })
    await waitFor(() => expect(screen.getByTestId('output-notice').textContent).toContain('approved by Owner'))
  })

  it('refuses to approve when the server has no verified version', async () => {
    const rest = vi.fn().mockResolvedValue({
      output: detail({ state: 'reviewing', verified: 0 }).output,
      eligibility: {},
      versions: [versionWire(1)],
      reviews: []
    })

    unbind = bindOperationsApi(rest as never)

    render(
      <DeliverablePackageOutput
        detail={detail({ state: 'verified', verified: 1, eligibility: { approve: true } })}
        meeting={productionMeeting()}
        meetingVersion={9}
      />
    )

    fireEvent.click(screen.getByRole('button', { name: /Approve this artifact version/ }))

    await waitFor(() =>
      expect(screen.getByTestId('output-error').textContent).toContain('no verified artifact version')
    )
    expect(rest.mock.calls.every(([path]) => !String(path).endsWith('/approve'))).toBe(true)
  })

  it('previews only a policy-approved member and keeps the rest download-only', async () => {
    const payload = new TextEncoder().encode('Step one. Step two.\n')

    const rest = vi.fn().mockResolvedValue({
      bytes: payload.buffer,
      mediaType: 'text/plain',
      status: 200,
      headers: { 'x-hermes-artifact-sha256': 'a'.repeat(64) }
    })

    unbind = bindOperationsApi(rest as never)

    render(<DeliverablePackageOutput detail={detail()} meeting={productionMeeting()} meetingVersion={7} />)

    // The download-only HTML member offers no preview affordance at all.
    expect(screen.queryByRole('button', { name: 'Preview page.html' })).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Preview index.txt' }))

    await waitFor(() => expect(screen.getByTestId('member-preview').textContent).toContain('Step one'))
    expect(rest.mock.calls[0][0]).toBe('/meeting-outputs/mout_1/versions/1/files/index.txt')
    expect(rest.mock.calls[0][1]).toEqual({ responseType: 'binary' })
  })

  it('verifies a download against the stored zip_sha256 and fails closed', async () => {
    const payload = new TextEncoder().encode('not the real package')

    const rest = vi.fn().mockResolvedValue({
      bytes: payload.buffer,
      mediaType: 'application/zip',
      status: 200,
      headers: { 'x-hermes-artifact-sha256': 'c'.repeat(64) }
    })

    unbind = bindOperationsApi(rest as never)

    render(<DeliverablePackageOutput detail={detail()} meeting={productionMeeting()} meetingVersion={7} />)

    fireEvent.click(screen.getByRole('button', { name: /Download artifact version 1/ }))

    await waitFor(() =>
      expect(screen.getByTestId('output-error').textContent).toContain('does not match the stored zip_sha256')
    )
  })

  it('reports the output state and the production stage for the operator', () => {
    const meeting = { ...productionMeeting(), productionStage: 'approval_ready' } as MeetingRecord

    render(
      <DeliverablePackageOutput
        detail={detail({ state: 'verified', verified: 1 })}
        meeting={meeting}
        meetingVersion={7}
      />
    )

    expect(screen.getByTestId('output-state').textContent).toBe('Verified')
    expect(screen.getByTestId('production-stage').textContent).toContain('Ready for approval')
  })

  it('exposes only independent reviewer seats as candidates', () => {
    const meeting = productionMeeting()

    expect(reviewerCandidates(meeting)).toEqual([reviewer])

    const noIndependent = {
      ...meeting,
      seats: [
        { bot: orchestrator, role: 'reviewer', label: 'O' },
        { bot: producer, role: 'reviewer', label: 'P' },
        { bot: reviewer, role: 'contributor', label: 'R' }
      ]
    } as MeetingRecord

    expect(reviewerCandidates(noIndependent)).toEqual([])
    expect(reviewerCandidates({ ...meeting, seats: undefined } as MeetingRecord)).toEqual([])
  })

  it('says so plainly when no artifact version exists yet', () => {
    render(
      <DeliverablePackageOutput
        detail={detail({ state: 'candidate', current: 0, versions: [] })}
        meeting={productionMeeting()}
        meetingVersion={7}
      />
    )

    expect(screen.getByTestId('no-artifact-yet').textContent).toContain('No artifact version')
  })
})
