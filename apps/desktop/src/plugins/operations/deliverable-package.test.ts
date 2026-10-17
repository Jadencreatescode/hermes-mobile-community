import { afterEach, describe, expect, it, vi } from 'vitest'

import { bindOperationsApi } from './api'
import {
  approveMeetingOutput,
  checksFromWire,
  claimOutputRun,
  claimReviewRun,
  collectOutputRun,
  completeReviewRun,
  createProductionRun,
  createReviewRun,
  createRevisionRun,
  downloadOutputPackage,
  eligibilityFromWire,
  freezeProductionBrief,
  getMeetingOutput,
  getOutputRecovery,
  isInlinePreviewable,
  listMeetingOutputs,
  manifestFromWire,
  outputFromWire,
  outputVersionFromWire,
  previewOutputFile,
  PRODUCT_KINDS,
  recoveryFromWire,
  reviewRunFromWire,
  sha256Hex,
  versionLineage
} from './deliverable-package'

const reviewer = { connectionId: 'local', profile: 'reviewer' }

let unbind: (() => void) | undefined

afterEach(() => {
  unbind?.()
  unbind = undefined
})

const manifestWire = {
  product_kind: 'document',
  title: 'Onboarding guide',
  summary: 'A one-page guide.',
  primary_file: 'index.txt',
  files: [
    {
      path: 'index.txt',
      media_type: 'text/plain',
      role: 'primary',
      preview_policy: 'text',
      byte_size: 12,
      sha256: 'a'.repeat(64)
    },
    {
      path: 'page.html',
      media_type: 'text/html',
      role: 'support',
      preview_policy: 'download_only',
      byte_size: 20,
      sha256: 'b'.repeat(64)
    }
  ]
}

const versionWire = {
  output_id: 'mout_1',
  artifact_version: 2,
  schema_version: 1,
  runtime_version: '1',
  game_sha256: 'a'.repeat(64),
  manifest_sha256: 'b'.repeat(64),
  zip_sha256: 'c'.repeat(64),
  total_byte_size: 32,
  parent_artifact_version: 1,
  manifest: manifestWire,
  created_at: 1_800_000_000
}

const outputWire = {
  output_id: 'mout_1',
  meeting_id: 'meeting_1',
  kind: 'deliverable_package_v1',
  product_kind: 'document',
  title: 'Onboarding guide',
  summary: 'A reviewer confirms every step.',
  brief: 'Produce the guide.',
  brief_hash: 'd'.repeat(64),
  producer: { connection: 'local', profile: 'producer' },
  source_meeting_version: 3,
  current_artifact_version: 2,
  verified_artifact_version: 2,
  approved_artifact_version: 0,
  state: 'verified',
  version: 7,
  findings: [],
  created_at: 1_800_000_000,
  updated_at: 1_800_000_100
}

describe('deliverable package DTO normalization', () => {
  it('converts the canonical snake_case wire into the camelCase model', () => {
    const manifest = manifestFromWire(manifestWire)

    expect(manifest).toEqual({
      productKind: 'document',
      title: 'Onboarding guide',
      summary: 'A one-page guide.',
      primaryFile: 'index.txt',
      files: [
        {
          path: 'index.txt',
          mediaType: 'text/plain',
          role: 'primary',
          previewPolicy: 'text',
          byteSize: 12,
          sha256: 'a'.repeat(64)
        },
        {
          path: 'page.html',
          mediaType: 'text/html',
          role: 'support',
          previewPolicy: 'download_only',
          byteSize: 20,
          sha256: 'b'.repeat(64)
        }
      ]
    })
    expect(Object.isFrozen(manifest)).toBe(true)
    expect(Object.isFrozen(manifest.files)).toBe(true)
  })

  it('keeps the certified game_sha256 compatibility name on a version', () => {
    const version = outputVersionFromWire(versionWire)

    expect(version.gameSha256).toBe('a'.repeat(64))
    expect(version.manifestSha256).toBe('b'.repeat(64))
    expect(version.zipSha256).toBe('c'.repeat(64))
    expect(version.artifactVersion).toBe(2)
    expect(version.parentArtifactVersion).toBe(1)
    expect(version.manifest.primaryFile).toBe('index.txt')
  })

  it('reads a null parent artifact version as the lineage root', () => {
    expect(outputVersionFromWire({ ...versionWire, parent_artifact_version: null }).parentArtifactVersion).toBeNull()
  })

  it('normalizes an output and bounds its state', () => {
    const output = outputFromWire(outputWire)

    expect(output.outputId).toBe('mout_1')
    expect(output.productKind).toBe('document')
    expect(output.producer).toEqual({ connectionId: 'local', profile: 'producer' })
    expect(output.currentArtifactVersion).toBe(2)
    expect(output.verifiedArtifactVersion).toBe(2)
    expect(output.state).toBe('verified')
    expect(outputFromWire({ ...outputWire, state: 'whatever' }).state).toBe('candidate')
    expect(PRODUCT_KINDS).toContain('interactive_web_app')
  })

  it('treats an absent eligibility flag as not allowed', () => {
    expect(eligibilityFromWire({ approve: true })).toEqual({
      produce: false,
      review: false,
      revise: false,
      approve: true,
      preview: false,
      download: false
    })
    expect(eligibilityFromWire(undefined).approve).toBe(false)
    // A truthy-but-not-true value never unlocks an action.
    expect(eligibilityFromWire({ approve: 'yes' }).approve).toBe(false)
  })

  it('normalizes a review run with its frozen hashes and findings', () => {
    const review = reviewRunFromWire({
      request_id: 'mrev_1',
      output_id: 'mout_1',
      output_version: 5,
      artifact_version: 2,
      reviewer: { connection: 'local', profile: 'reviewer' },
      state: 'completed',
      verdict: 'changes_requested',
      findings: [{ severity: 'high', code: 'missing_step', detail: 'Add step three.', path: 'index.txt' }],
      checks: { ok: false, checks: { zip_digest: true, per_file_digest: false }, failed_checks: ['per_file_digest'] },
      game_sha256: 'a'.repeat(64),
      manifest_sha256: 'b'.repeat(64),
      zip_sha256: 'c'.repeat(64),
      created_at: 1,
      completed_at: 2
    })

    expect(review.reviewer).toEqual(reviewer)
    expect(review.verdict).toBe('changes_requested')
    expect(review.findings[0]).toEqual({
      severity: 'high',
      code: 'missing_step',
      detail: 'Add step three.',
      path: 'index.txt'
    })
    expect(review.checks.ok).toBe(false)
    expect(review.checks.failedChecks).toEqual(['per_file_digest'])
    expect(review.zipSha256).toBe('c'.repeat(64))
  })

  it('reads a check as failed unless it is exactly true', () => {
    const checks = checksFromWire({ ok: true, checks: { a: true, b: 1, c: 'true' }, failed_checks: [] })

    expect(checks.checks).toEqual({ a: true, b: false, c: false })
    expect(checksFromWire(undefined).ok).toBe(false)
  })

  it('normalizes recovery state after a restart', () => {
    const recovery = recoveryFromWire({
      output: outputWire,
      observed_at: 100,
      active_run: { run_id: 'mrun_1', kind: 'revision', state: 'open' },
      active_review: { request_id: 'mrev_9', artifact_version: 2 },
      active_prompt_claim: {
        claim_id: 'mclaim_1',
        scope: 'mrun_1',
        session_id: 'session-1',
        expires_at: 90,
        renewals: 2
      },
      receipt: {
        run_id: 'mrun_0',
        output_id: 'mout_1',
        artifact_version: 2,
        parent_artifact_version: 1,
        game_sha256: 'a'.repeat(64),
        manifest_sha256: 'b'.repeat(64),
        zip_sha256: 'c'.repeat(64),
        total_byte_size: 32,
        collected_at: 5
      }
    })

    expect(recovery.activeRunId).toBe('mrun_1')
    expect(recovery.activeReviewRequestId).toBe('mrev_9')
    expect(recovery.activePromptClaimId).toBe('mclaim_1')
    expect(recovery.observedAt).toBe(100)
    expect(recovery.activePromptClaim).toEqual({
      claimId: 'mclaim_1',
      scope: 'mrun_1',
      sessionId: 'session-1',
      expiresAt: 90,
      renewals: 2
    })
    expect(recovery.receipt?.zipSha256).toBe('c'.repeat(64))
    expect(recoveryFromWire({ output: outputWire }).activeRunId).toBeNull()
    expect(recoveryFromWire({ output: outputWire }).receipt).toBeNull()
  })

  it('orders lineage oldest first and gates inline preview by policy', () => {
    const versions = [
      outputVersionFromWire({ ...versionWire, artifact_version: 2, parent_artifact_version: 1 }),
      outputVersionFromWire({ ...versionWire, artifact_version: 1, parent_artifact_version: null })
    ]

    expect(versionLineage(versions).map(row => row.artifactVersion)).toEqual([1, 2])

    const manifest = manifestFromWire(manifestWire)
    expect(isInlinePreviewable(manifest.files[0])).toBe(true)
    expect(isInlinePreviewable(manifest.files[1])).toBe(false)
  })
})

describe('deliverable package REST clients', () => {
  it('lists and reads outputs through the authenticated plugin namespace', async () => {
    const rest = vi
      .fn()
      .mockResolvedValueOnce({ outputs: [{ output: outputWire, eligibility: { approve: true } }] })
      .mockResolvedValueOnce({
        output: outputWire,
        eligibility: { approve: true, download: true },
        versions: [versionWire],
        reviews: []
      })

    unbind = bindOperationsApi(rest as never)

    const listed = await listMeetingOutputs('meeting_1')
    expect(rest).toHaveBeenCalledWith('/meetings/meeting_1/outputs?limit=20')
    expect(listed[0].output.outputId).toBe('mout_1')
    expect(listed[0].eligibility.approve).toBe(true)

    const detail = await getMeetingOutput('mout_1')
    expect(rest).toHaveBeenLastCalledWith('/meeting-outputs/mout_1')
    expect(detail.versions[0].artifactVersion).toBe(2)
  })

  it('freezes a brief and starts a run with canonical snake_case bodies', async () => {
    const rest = vi
      .fn()
      .mockResolvedValueOnce({ meeting_version: 4, brief_hash: 'd'.repeat(64), production_stage: 'production_ready' })
      .mockResolvedValueOnce({
        run_id: 'mrun_1',
        output_id: 'mout_1',
        kind: 'production',
        meeting_id: 'meeting_1',
        meeting_version: 5,
        parent_artifact_version: null,
        workspace_identity: { device: '1', inode: '2', output_device: '1', output_inode: '3' }
      })

    unbind = bindOperationsApi(rest as never)

    const frozen = await freezeProductionBrief({
      meetingId: 'meeting_1',
      expectedVersion: 3,
      brief: 'Produce the guide.',
      evidenceRefs: ['note://round-1'],
      idempotencyKey: 'brief-1'
    })

    expect(rest).toHaveBeenCalledWith('/meetings/meeting_1/production-brief', {
      method: 'POST',
      body: {
        expected_version: 3,
        brief: 'Produce the guide.',
        evidence_refs: ['note://round-1']
      },
      headers: { 'Idempotency-Key': 'brief-1' }
    })
    expect(frozen).toEqual({ meetingVersion: 4, briefHash: 'd'.repeat(64), productionStage: 'production_ready' })

    const run = await createProductionRun({
      meetingId: 'meeting_1',
      expectedVersion: 4,
      producerSessionId: 'session-1',
      submissionId: 'submission-1',
      idempotencyKey: 'production-run-1'
    })

    expect(rest).toHaveBeenLastCalledWith('/meetings/meeting_1/production-runs', {
      method: 'POST',
      body: {
        expected_version: 4,
        producer_session_id: 'session-1',
        submission_id: 'submission-1'
      },
      headers: { 'Idempotency-Key': 'production-run-1' }
    })
    expect(run).toEqual({
      runId: 'mrun_1',
      outputId: 'mout_1',
      kind: 'production',
      meetingId: 'meeting_1',
      meetingVersion: 5,
      parentArtifactVersion: null,
      cwd: '',
      workspaceIdentity: { device: '1', inode: '2', outputDevice: '1', outputInode: '3' }
    })
  })

  it('parses the server-assigned cwd off the create-run dispatcher response', async () => {
    const rest = vi
      .fn()
      .mockResolvedValueOnce({
        run_id: 'mrun_1',
        output_id: 'mout_1',
        kind: 'production',
        meeting_id: 'meeting_1',
        meeting_version: 5,
        parent_artifact_version: null,
        cwd: '/server/owned/workspaces/mrun_1',
        workspace_identity: { device: '1', inode: '2', output_device: '1', output_inode: '3' }
      })
      .mockResolvedValueOnce({
        run_id: 'mrun_2',
        output_id: 'mout_1',
        kind: 'revision',
        meeting_id: 'meeting_1',
        meeting_version: 9,
        parent_artifact_version: 1,
        cwd: '/server/owned/workspaces/mrun_2',
        workspace_identity: { device: '1', inode: '4', output_device: '1', output_inode: '5' }
      })

    unbind = bindOperationsApi(rest as never)

    const production = await createProductionRun({
      meetingId: 'meeting_1',
      expectedVersion: 4,
      producerSessionId: 'provisional-1',
      submissionId: 'submission-1',
      idempotencyKey: 'production-run-1'
    })

    const revision = await createRevisionRun({
      outputId: 'mout_1',
      expectedOutputVersion: 7,
      producerSessionId: 'provisional-revision-1',
      idempotencyKey: 'revision-run-1'
    })

    // The dispatcher needs the cwd to open the producer session; it is the one
    // place a host path crosses the wire, and never a collection claim.
    expect(production.cwd).toBe('/server/owned/workspaces/mrun_1')
    expect(revision.cwd).toBe('/server/owned/workspaces/mrun_2')
    expect(Object.keys(production)).not.toContain('collectionClaim')
  })

  it('routes a revision run and its claim/collect through the revision paths', async () => {
    const rest = vi
      .fn()
      .mockResolvedValueOnce({
        run_id: 'mrun_2',
        output_id: 'mout_1',
        kind: 'revision',
        meeting_id: 'meeting_1',
        meeting_version: 9,
        parent_artifact_version: 1,
        workspace_identity: { device: '1', inode: '4', output_device: '1', output_inode: '5' }
      })
      .mockResolvedValueOnce({
        run_id: 'mrun_2',
        output_id: 'mout_1',
        kind: 'revision',
        workspace: {
          cwd: '/server/owned/path',
          identity: { device: '1', inode: '4', output_device: '1', output_inode: '5' }
        },
        collection_claim: 'claim-token',
        brief: 'Produce the guide.',
        brief_hash: 'd'.repeat(64),
        acceptance_statement: 'Reviewed.',
        parent_artifact_version: 1
      })
      .mockResolvedValueOnce({
        receipt: {
          run_id: 'mrun_2',
          output_id: 'mout_1',
          artifact_version: 2,
          parent_artifact_version: 1,
          game_sha256: 'a'.repeat(64),
          manifest_sha256: 'b'.repeat(64),
          zip_sha256: 'c'.repeat(64),
          total_byte_size: 32,
          collected_at: 7
        },
        output: outputWire,
        eligibility: { review: true }
      })

    unbind = bindOperationsApi(rest as never)

    const revision = await createRevisionRun({
      outputId: 'mout_1',
      expectedOutputVersion: 6,
      producerSessionId: 'session-2',
      idempotencyKey: 'revision-run-2'
    })

    expect(rest).toHaveBeenCalledWith('/meeting-outputs/mout_1/revision-runs', {
      method: 'POST',
      body: { expected_output_version: 6, producer_session_id: 'session-2' },
      headers: { 'Idempotency-Key': 'revision-run-2' }
    })
    expect(revision.parentArtifactVersion).toBe(1)

    const claim = await claimOutputRun({
      runId: 'mrun_2',
      requestId: 'dispatch-1',
      sessionId: 'session-2',
      kind: 'revision'
    })

    expect(rest).toHaveBeenLastCalledWith('/meeting-output-revision-runs/mrun_2/claim', {
      method: 'POST',
      body: { request_id: 'dispatch-1', session_id: 'session-2' },
      headers: { 'Idempotency-Key': 'claim-mrun_2-g0-session-2' }
    })
    expect(claim.cwd).toBe('/server/owned/path')
    expect(claim.collectionClaim).toBe('claim-token')
    expect(claim.workspaceIdentity).toEqual({
      device: '1',
      inode: '4',
      outputDevice: '1',
      outputInode: '5'
    })

    const collected = await collectOutputRun({
      runId: 'mrun_2',
      collectionClaim: 'claim-token',
      kind: 'revision',
      idempotencyKey: 'collect-1'
    })

    expect(rest).toHaveBeenLastCalledWith('/meeting-output-revision-runs/mrun_2/collect', {
      method: 'POST',
      body: { collection_claim: 'claim-token' },
      headers: { 'Idempotency-Key': 'collect-1' }
    })
    expect(collected.receipt.artifactVersion).toBe(2)
    expect(collected.receipt.parentArtifactVersion).toBe(1)
  })

  it('sends the reviewer as a canonical route and posts structured findings', async () => {
    const rest = vi
      .fn()
      .mockResolvedValueOnce({
        request_id: 'mrev_1',
        artifact_version: 2,
        checks: { ok: true, checks: { zip_digest: true }, failed_checks: [] },
        artifact_summary: { files: manifestWire.files }
      })
      .mockResolvedValueOnce({
        review: {
          request_id: 'mrev_1',
          artifact_version: 2,
          verdict: 'changes_requested',
          state: 'completed',
          reviewer: { connection: 'local', profile: 'reviewer' },
          findings: [],
          checks: {},
          created_at: 1
        },
        output: outputWire,
        eligibility: { revise: true }
      })

    unbind = bindOperationsApi(rest as never)

    const review = await createReviewRun({
      outputId: 'mout_1',
      expectedOutputVersion: 6,
      reviewer,
      idempotencyKey: 'review-run-1'
    })

    expect(rest).toHaveBeenCalledWith('/meeting-outputs/mout_1/review-runs', {
      method: 'POST',
      body: { expected_output_version: 6, reviewer: { connection: 'local', profile: 'reviewer' } },
      headers: { 'Idempotency-Key': 'review-run-1' }
    })
    expect(review.checks.ok).toBe(true)
    expect(review.manifest[0].path).toBe('index.txt')

    await completeReviewRun({
      requestId: 'mrev_1',
      verdict: 'changes_requested',
      findings: [{ severity: 'high', code: 'missing_step', detail: 'Add step three.', path: 'index.txt' }],
      idempotencyKey: 'verdict-mrev_1'
    })
    expect(rest).toHaveBeenLastCalledWith('/meeting-output-review-runs/mrev_1/complete', {
      method: 'POST',
      body: {
        verdict: 'changes_requested',
        findings: [{ severity: 'high', code: 'missing_step', detail: 'Add step three.', path: 'index.txt' }]
      },
      headers: { 'Idempotency-Key': 'verdict-mrev_1' }
    })
  })

  it('approves by echoing server hashes and never sends an approver', async () => {
    const rest = vi.fn().mockResolvedValue({
      output: { ...outputWire, state: 'approved', approved_artifact_version: 2 },
      eligibility: { download: true },
      artifact_binding: {
        output_id: 'mout_1',
        artifact_version: 2,
        game_sha256: 'a'.repeat(64),
        manifest_sha256: 'b'.repeat(64),
        zip_sha256: 'c'.repeat(64),
        approved_by: 'Owner',
        approved_at: 1_800_000_200
      }
    })

    unbind = bindOperationsApi(rest as never)

    const approved = await approveMeetingOutput({
      outputId: 'mout_1',
      meetingId: 'meeting_1',
      expectedMeetingVersion: 9,
      expectedOutputVersion: 7,
      version: outputVersionFromWire(versionWire),
      idempotencyKey: 'approve-1'
    })

    const [, options] = rest.mock.calls[0]
    expect(rest).toHaveBeenCalledWith('/meeting-outputs/mout_1/approve', expect.anything())
    expect(options.body).toEqual({
      meeting_id: 'meeting_1',
      expected_meeting_version: 9,
      expected_output_version: 7,
      artifact_version: 2,
      game_sha256: 'a'.repeat(64),
      manifest_sha256: 'b'.repeat(64),
      zip_sha256: 'c'.repeat(64)
    })
    // No approver identity and no approval time may leave the renderer.
    expect(Object.keys(options.body)).not.toContain('approved_by')
    expect(Object.keys(options.body)).not.toContain('approved_at')
    expect(options.headers).toEqual({ 'Idempotency-Key': 'approve-1' })
    expect(approved.output.state).toBe('approved')
    expect(approved.artifactBinding.approved_by).toBe('Owner')
  })

  it('reads preview and download bytes as binary with their reported digest', async () => {
    const payload = new TextEncoder().encode('step one\n')

    const rest = vi.fn().mockResolvedValue({
      bytes: payload.buffer,
      mediaType: 'text/plain',
      status: 200,
      headers: { 'x-hermes-artifact-sha256': 'a'.repeat(64) }
    })

    unbind = bindOperationsApi(rest as never)

    const preview = await previewOutputFile({ outputId: 'mout_1', artifactVersion: 2, path: 'notes/checklist.txt' })
    expect(rest).toHaveBeenCalledWith('/meeting-outputs/mout_1/versions/2/files/notes/checklist.txt', {
      responseType: 'binary'
    })
    expect(preview.mediaType).toBe('text/plain')
    expect(preview.sha256).toBe('a'.repeat(64))

    await downloadOutputPackage({ outputId: 'mout_1', artifactVersion: 2 })
    expect(rest).toHaveBeenLastCalledWith('/meeting-outputs/mout_1/versions/2/download', { responseType: 'binary' })
  })

  it('percent-encodes each preview path segment without collapsing the path', async () => {
    const rest = vi.fn().mockResolvedValue({
      bytes: new ArrayBuffer(1),
      mediaType: 'text/plain',
      status: 200,
      headers: {}
    })

    unbind = bindOperationsApi(rest as never)
    await previewOutputFile({ outputId: 'mout_1', artifactVersion: 1, path: 'a b/c#d.txt' })

    expect(rest).toHaveBeenCalledWith('/meeting-outputs/mout_1/versions/1/files/a%20b/c%23d.txt', {
      responseType: 'binary'
    })
  })

  it('refuses an artifact response that carries no bytes', async () => {
    unbind = bindOperationsApi(vi.fn().mockResolvedValue({ bytes: 'not-bytes' }) as never)

    await expect(previewOutputFile({ outputId: 'mout_1', artifactVersion: 1, path: 'index.txt' })).rejects.toThrow(
      'did not carry bytes'
    )
  })

  it('rejects an invalid output id or artifact version before any request', async () => {
    const rest = vi.fn()

    unbind = bindOperationsApi(rest as never)

    await expect(getMeetingOutput('../escape')).rejects.toThrow('Output id is invalid')
    await expect(downloadOutputPackage({ outputId: 'mout_1', artifactVersion: 0 })).rejects.toThrow(
      'Artifact version is invalid'
    )
    expect(rest).not.toHaveBeenCalled()
  })

  it('reads recovery through the authenticated recovery route', async () => {
    const rest = vi.fn().mockResolvedValue({ output: outputWire, active_run: null, receipt: null })

    unbind = bindOperationsApi(rest as never)
    const recovery = await getOutputRecovery('mout_1')

    expect(rest).toHaveBeenCalledWith('/meeting-outputs/mout_1/recovery')
    expect(recovery.output.outputId).toBe('mout_1')
  })

  it('recomputes a downloaded digest so the UI can prove it equals zip_sha256', async () => {
    const payload = new TextEncoder().encode('deliverable bytes')

    await expect(sha256Hex(payload.buffer as ArrayBuffer)).resolves.toMatch(/^[0-9a-f]{64}$/)
  })

  it('sends a stable idempotency key on both dispatch claims', async () => {
    // The claim consumes a dispatch lease, so a retry that the server cannot
    // recognize cannot read back the cwd or the collection claim it granted.
    // The key is derived from the run/review and the session being bound, so
    // the identical retry replays and a different session still conflicts.
    const rest = vi
      .fn()
      .mockResolvedValueOnce({
        run_id: 'mrun_1',
        output_id: 'mout_1',
        kind: 'production',
        workspace: { cwd: '/server/owned/path' },
        collection_claim: 'claim-token',
        brief: 'Produce the guide.',
        brief_hash: 'd'.repeat(64),
        acceptance_statement: 'Reviewed.',
        parent_artifact_version: null,
        session_id: 'session-1',
        claim: { renewals: 0 }
      })
      .mockResolvedValueOnce({
        request_id: 'mrev_1',
        artifact_version: 2,
        reviewer: { connection: 'local', profile: 'reviewer' }
      })

    unbind = bindOperationsApi(rest as never)

    await claimOutputRun({ runId: 'mrun_1', requestId: 'dispatch-1', sessionId: 'session-1' })
    expect(rest).toHaveBeenLastCalledWith('/meeting-output-runs/mrun_1/claim', {
      method: 'POST',
      body: { request_id: 'dispatch-1', session_id: 'session-1' },
      headers: { 'Idempotency-Key': 'claim-mrun_1-g0-session-1' }
    })

    await claimReviewRun({
      requestId: 'mrev_1',
      dispatchId: 'review-dispatch-1',
      sessionId: 'session-reviewer-1',
      claimGeneration: 2
    })
    expect(rest).toHaveBeenLastCalledWith('/meeting-output-review-runs/mrev_1/claim', {
      method: 'POST',
      body: { request_id: 'review-dispatch-1', session_id: 'session-reviewer-1' },
      headers: { 'Idempotency-Key': 'review-claim-mrev_1-g2-session-reviewer-1' }
    })
  })

  it('refuses to send a lifecycle mutation with a blank idempotency key', async () => {
    const rest = vi.fn()

    unbind = bindOperationsApi(rest as never)

    await expect(
      freezeProductionBrief({
        meetingId: 'meeting_1',
        expectedVersion: 3,
        brief: 'Produce the guide.',
        idempotencyKey: '  '
      })
    ).rejects.toThrow('idempotency key')
    expect(rest).not.toHaveBeenCalled()
  })
})
