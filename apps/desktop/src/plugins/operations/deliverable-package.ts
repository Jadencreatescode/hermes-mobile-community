// Public DTO + typed API client for the production-meeting output lifecycle.
//
// Two rules shape this file:
//
//  1. The wire is canonical snake_case. The renderer model is camelCase, and
//     every conversion happens here, at the boundary.
//  2. The server owns the truth. Nothing here authors a hash, an approver, an
//     approval time, a production stage, or an artifact binding; the approval
//     request only *echoes back* values the server already published, which is
//     what makes a stale approval detectable instead of silently applied.

import type { PluginBinaryResponse } from '@hermes/plugin-sdk'

import { operationsApi } from './api'
import type { RouteIdentity } from './meetings'

export const OUTPUT_KIND = 'deliverable_package_v1'

export const PRODUCT_KINDS = [
  'interactive_web_app',
  'three_scene',
  'audio_asset',
  'video_asset',
  'document'
] as const

export type ProductKind = typeof PRODUCT_KINDS[number]

export const OUTPUT_STATES = ['candidate', 'reviewing', 'changes_requested', 'verified', 'approved'] as const

export type OutputState = typeof OUTPUT_STATES[number]

export type FindingSeverity = 'low' | 'medium' | 'high' | 'critical'

export type PreviewPolicy = 'text' | 'image' | 'download_only'

export interface ManifestFile {
  readonly path: string
  readonly mediaType: string
  readonly role: string
  readonly previewPolicy: PreviewPolicy
  readonly byteSize: number
  readonly sha256: string
}

export interface PackageManifest {
  readonly productKind: string
  readonly title: string
  readonly summary: string
  readonly primaryFile: string
  readonly files: readonly ManifestFile[]
}

export interface OutputVersion {
  readonly artifactVersion: number
  readonly schemaVersion: number
  readonly runtimeVersion: string
  /** The manifest's primary-file digest. Certified compatibility name. */
  readonly gameSha256: string
  readonly manifestSha256: string
  readonly zipSha256: string
  readonly totalByteSize: number
  readonly parentArtifactVersion: number | null
  readonly manifest: PackageManifest
  readonly createdAt: number
}

export interface ReviewFinding {
  readonly severity: FindingSeverity
  readonly code: string
  readonly detail: string
  readonly path?: string
}

export interface DeterministicChecks {
  readonly ok: boolean
  readonly checks: Readonly<Record<string, boolean>>
  readonly failedChecks: readonly string[]
}

export interface ReviewRun {
  readonly requestId: string
  readonly artifactVersion: number
  readonly reviewer: RouteIdentity
  readonly state: 'open' | 'completed'
  readonly verdict: '' | 'verified' | 'changes_requested'
  readonly findings: readonly ReviewFinding[]
  readonly checks: DeterministicChecks
  readonly gameSha256: string
  readonly manifestSha256: string
  readonly zipSha256: string
  readonly createdAt: number
  readonly completedAt: number | null
}

export interface OutputEligibility {
  readonly produce: boolean
  readonly review: boolean
  readonly revise: boolean
  readonly approve: boolean
  readonly preview: boolean
  readonly download: boolean
}

export interface MeetingOutput {
  readonly outputId: string
  readonly meetingId: string
  readonly kind: string
  readonly productKind: string
  readonly title: string
  readonly summary: string
  readonly brief: string
  readonly briefHash: string
  readonly producer: RouteIdentity
  readonly sourceMeetingVersion: number
  readonly currentArtifactVersion: number
  readonly verifiedArtifactVersion: number
  readonly approvedArtifactVersion: number
  readonly state: OutputState
  readonly version: number
  readonly findings: readonly ReviewFinding[]
  readonly createdAt: number
  readonly updatedAt: number
}

/** What the LIST route actually returns for each output: the record and the
 *  server's eligibility flags, and nothing else. Versions and reviews come
 *  from the detail route, so a caller that needs them has to ask for them. */
export interface MeetingOutputSummary {
  readonly output: MeetingOutput
  readonly eligibility: OutputEligibility
}

export interface MeetingOutputDetail extends MeetingOutputSummary {
  readonly versions: readonly OutputVersion[]
  readonly reviews: readonly ReviewRun[]
}

export interface OutputRun {
  readonly runId: string
  readonly outputId: string
  readonly kind: 'production' | 'revision'
  readonly meetingId: string
  readonly meetingVersion: number
  readonly parentArtifactVersion: number | null
  /** The server-assigned workspace cwd, present ONLY on the authenticated
   *  create-run response the dispatcher uses to open the producer session.
   *  It is never part of an output DTO and is never rendered. */
  readonly cwd: string
}

export interface CollectionReceipt {
  readonly runId: string
  readonly outputId: string
  readonly artifactVersion: number
  readonly parentArtifactVersion: number | null
  readonly gameSha256: string
  readonly manifestSha256: string
  readonly zipSha256: string
  readonly totalByteSize: number
  readonly collectedAt: number
}

export interface OutputRecovery {
  readonly output: MeetingOutput
  readonly activeRunId: string | null
  readonly activeReviewRequestId: string | null
  readonly activePromptClaimId: string | null
  readonly receipt: CollectionReceipt | null
}

export interface ArtifactBytes {
  readonly bytes: ArrayBuffer
  readonly mediaType: string
  /** Digest the backend reports for the bytes it served. */
  readonly sha256: string
  readonly status: number
}

// ---------------------------------------------------------------------------
// wire normalization
// ---------------------------------------------------------------------------

function row(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function count(value: unknown): number {
  return Number.isFinite(Number(value)) ? Number(value) : 0
}

function nullableCount(value: unknown): number | null {
  return value === null || value === undefined ? null : count(value)
}

function routeFrom(value: unknown): RouteIdentity {
  const source = row(value)

  return Object.freeze({
    connectionId: text(source.connection ?? source.connectionId),
    profile: text(source.profile)
  })
}

/** The canonical wire route shape: `{connection, profile}`. */
export function routeToWire(value: RouteIdentity): { connection: string; profile: string } {
  return { connection: value.connectionId, profile: value.profile }
}

function previewPolicy(value: unknown): PreviewPolicy {
  const policy = text(value)

  return policy === 'text' || policy === 'image' ? policy : 'download_only'
}

export function manifestFileFromWire(value: unknown): ManifestFile {
  const source = row(value)

  return Object.freeze({
    path: text(source.path),
    mediaType: text(source.media_type ?? source.mediaType),
    role: text(source.role),
    previewPolicy: previewPolicy(source.preview_policy ?? source.previewPolicy),
    byteSize: count(source.byte_size ?? source.byteSize),
    sha256: text(source.sha256)
  })
}

export function manifestFromWire(value: unknown): PackageManifest {
  const source = row(value)

  return Object.freeze({
    productKind: text(source.product_kind ?? source.productKind),
    title: text(source.title),
    summary: text(source.summary),
    primaryFile: text(source.primary_file ?? source.primaryFile),
    files: Object.freeze(list(source.files).map(manifestFileFromWire))
  })
}

export function outputVersionFromWire(value: unknown): OutputVersion {
  const source = row(value)

  return Object.freeze({
    artifactVersion: count(source.artifact_version ?? source.artifactVersion),
    schemaVersion: count(source.schema_version ?? source.schemaVersion),
    runtimeVersion: text(source.runtime_version ?? source.runtimeVersion),
    gameSha256: text(source.game_sha256 ?? source.gameSha256),
    manifestSha256: text(source.manifest_sha256 ?? source.manifestSha256),
    zipSha256: text(source.zip_sha256 ?? source.zipSha256),
    totalByteSize: count(source.total_byte_size ?? source.totalByteSize),
    parentArtifactVersion: nullableCount(source.parent_artifact_version ?? source.parentArtifactVersion),
    manifest: manifestFromWire(source.manifest),
    createdAt: count(source.created_at ?? source.createdAt)
  })
}

export function findingFromWire(value: unknown): ReviewFinding {
  const source = row(value)
  const severity = text(source.severity)
  const path = text(source.path)

  return Object.freeze({
    severity: (['low', 'medium', 'high', 'critical'].includes(severity)
      ? severity
      : 'low') as FindingSeverity,
    code: text(source.code),
    detail: text(source.detail),
    ...(path ? { path } : {})
  })
}

export function checksFromWire(value: unknown): DeterministicChecks {
  const source = row(value)
  const checks = row(source.checks)

  return Object.freeze({
    ok: source.ok === true,
    checks: Object.freeze(Object.fromEntries(
      Object.entries(checks).map(([key, item]) => [key, item === true])
    )),
    failedChecks: Object.freeze(list(source.failed_checks ?? source.failedChecks).map(text))
  })
}

export function reviewRunFromWire(value: unknown): ReviewRun {
  const source = row(value)
  const verdict = text(source.verdict)

  return Object.freeze({
    requestId: text(source.request_id ?? source.requestId),
    artifactVersion: count(source.artifact_version ?? source.artifactVersion),
    reviewer: routeFrom(source.reviewer),
    state: text(source.state) === 'completed' ? 'completed' : 'open',
    verdict: (verdict === 'verified' || verdict === 'changes_requested' ? verdict : '') as ReviewRun['verdict'],
    findings: Object.freeze(list(source.findings).map(findingFromWire)),
    checks: checksFromWire(source.checks),
    gameSha256: text(source.game_sha256 ?? source.gameSha256),
    manifestSha256: text(source.manifest_sha256 ?? source.manifestSha256),
    zipSha256: text(source.zip_sha256 ?? source.zipSha256),
    createdAt: count(source.created_at ?? source.createdAt),
    completedAt: nullableCount(source.completed_at ?? source.completedAt)
  })
}

export function outputFromWire(value: unknown): MeetingOutput {
  const source = row(value)
  const state = text(source.state)

  return Object.freeze({
    outputId: text(source.output_id ?? source.outputId),
    meetingId: text(source.meeting_id ?? source.meetingId),
    kind: text(source.kind),
    productKind: text(source.product_kind ?? source.productKind),
    title: text(source.title),
    summary: text(source.summary),
    brief: text(source.brief),
    briefHash: text(source.brief_hash ?? source.briefHash),
    producer: routeFrom(source.producer),
    sourceMeetingVersion: count(source.source_meeting_version ?? source.sourceMeetingVersion),
    currentArtifactVersion: count(source.current_artifact_version ?? source.currentArtifactVersion),
    verifiedArtifactVersion: count(source.verified_artifact_version ?? source.verifiedArtifactVersion),
    approvedArtifactVersion: count(source.approved_artifact_version ?? source.approvedArtifactVersion),
    state: (OUTPUT_STATES as readonly string[]).includes(state)
      ? state as OutputState
      : 'candidate',
    version: count(source.version),
    findings: Object.freeze(list(source.findings).map(findingFromWire)),
    createdAt: count(source.created_at ?? source.createdAt),
    updatedAt: count(source.updated_at ?? source.updatedAt)
  })
}

/** Eligibility is server-declared. An absent flag reads as "not allowed". */
export function eligibilityFromWire(value: unknown): OutputEligibility {
  const source = row(value)

  return Object.freeze({
    produce: source.produce === true,
    review: source.review === true,
    revise: source.revise === true,
    approve: source.approve === true,
    preview: source.preview === true,
    download: source.download === true
  })
}

export function outputDetailFromWire(value: unknown): MeetingOutputDetail {
  const source = row(value)

  return Object.freeze({
    output: outputFromWire(source.output),
    eligibility: eligibilityFromWire(source.eligibility),
    versions: Object.freeze(list(source.versions).map(outputVersionFromWire)),
    reviews: Object.freeze(list(source.reviews).map(reviewRunFromWire))
  })
}

export function runFromWire(value: unknown): OutputRun {
  const source = row(value)

  return Object.freeze({
    runId: text(source.run_id ?? source.runId),
    outputId: text(source.output_id ?? source.outputId),
    kind: text(source.kind) === 'revision' ? 'revision' : 'production',
    meetingId: text(source.meeting_id ?? source.meetingId),
    meetingVersion: count(source.meeting_version ?? source.meetingVersion),
    parentArtifactVersion: nullableCount(source.parent_artifact_version ?? source.parentArtifactVersion),
    cwd: text(source.cwd)
  })
}

export function receiptFromWire(value: unknown): CollectionReceipt {
  const source = row(value)

  return Object.freeze({
    runId: text(source.run_id ?? source.runId),
    outputId: text(source.output_id ?? source.outputId),
    artifactVersion: count(source.artifact_version ?? source.artifactVersion),
    parentArtifactVersion: nullableCount(source.parent_artifact_version ?? source.parentArtifactVersion),
    gameSha256: text(source.game_sha256 ?? source.gameSha256),
    manifestSha256: text(source.manifest_sha256 ?? source.manifestSha256),
    zipSha256: text(source.zip_sha256 ?? source.zipSha256),
    totalByteSize: count(source.total_byte_size ?? source.totalByteSize),
    collectedAt: count(source.collected_at ?? source.collectedAt)
  })
}

export function recoveryFromWire(value: unknown): OutputRecovery {
  const source = row(value)
  const activeRun = row(source.active_run ?? source.activeRun)
  const activeReview = row(source.active_review ?? source.activeReview)
  const activeClaim = row(source.active_prompt_claim ?? source.activePromptClaim)
  const receipt = source.receipt

  return Object.freeze({
    output: outputFromWire(source.output),
    activeRunId: text(activeRun.run_id ?? activeRun.runId) || null,
    activeReviewRequestId: text(activeReview.request_id ?? activeReview.requestId) || null,
    activePromptClaimId: text(activeClaim.claim_id ?? activeClaim.claimId) || null,
    receipt: receipt ? receiptFromWire(receipt) : null
  })
}

/** Lineage from the oldest artifact version to the newest, by parent link. */
export function versionLineage(versions: readonly OutputVersion[]): readonly OutputVersion[] {
  return Object.freeze([...versions].sort((left, right) => left.artifactVersion - right.artifactVersion))
}

/** True when the UI may preview this member inline rather than download it. */
export function isInlinePreviewable(file: ManifestFile): boolean {
  return file.previewPolicy === 'text' || file.previewPolicy === 'image'
}

// ---------------------------------------------------------------------------
// typed REST clients
// ---------------------------------------------------------------------------

function outputId(value: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(value)) {
    throw new Error('Output id is invalid')
  }

  return value
}

function artifactVersion(value: number): number {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error('Artifact version is invalid')
  }

  return value
}

function idempotent(key?: string): { headers?: Record<string, string> } {
  return key ? { headers: { 'Idempotency-Key': key } } : {}
}

export function outputSummaryFromWire(value: unknown): MeetingOutputSummary {
  const source = row(value)

  return Object.freeze({
    output: outputFromWire(source.output),
    eligibility: eligibilityFromWire(source.eligibility)
  })
}

/** List the meeting's outputs. This is the lean server shape -- ask
 *  getMeetingOutput for versions and reviews. */
export async function listMeetingOutputs(meetingId: string): Promise<MeetingOutputSummary[]> {
  const response = await operationsApi()<{ outputs?: unknown[] }>(
    `/meetings/${outputId(meetingId)}/outputs?limit=20`
  )

  return (response.outputs ?? []).map(outputSummaryFromWire)
}

export async function getMeetingOutput(id: string): Promise<MeetingOutputDetail> {
  return outputDetailFromWire(await operationsApi()<unknown>(`/meeting-outputs/${outputId(id)}`))
}

export async function listOutputVersions(id: string): Promise<OutputVersion[]> {
  const response = await operationsApi()<{ versions?: unknown[] }>(
    `/meeting-outputs/${outputId(id)}/versions`
  )

  return (response.versions ?? []).map(outputVersionFromWire)
}

export async function getOutputRecovery(id: string): Promise<OutputRecovery> {
  return recoveryFromWire(await operationsApi()<unknown>(`/meeting-outputs/${outputId(id)}/recovery`))
}

export async function freezeProductionBrief(input: {
  meetingId: string
  expectedVersion: number
  brief: string
  evidenceRefs?: readonly string[]
  idempotencyKey?: string
}): Promise<{ meetingVersion: number; briefHash: string; productionStage: string }> {
  const response = row(await operationsApi()<unknown>(
    `/meetings/${outputId(input.meetingId)}/production-brief`,
    {
      method: 'POST',
      body: {
        expected_version: input.expectedVersion,
        brief: input.brief,
        evidence_refs: [...(input.evidenceRefs ?? [])]
      },
      ...idempotent(input.idempotencyKey)
    }
  ))

  return {
    meetingVersion: count(response.meeting_version),
    briefHash: text(response.brief_hash),
    productionStage: text(response.production_stage)
  }
}

export async function createProductionRun(input: {
  meetingId: string
  expectedVersion: number
  producerSessionId: string
  submissionId: string
  idempotencyKey?: string
}): Promise<OutputRun> {
  return runFromWire(await operationsApi()<unknown>(
    `/meetings/${outputId(input.meetingId)}/production-runs`,
    {
      method: 'POST',
      body: {
        expected_version: input.expectedVersion,
        producer_session_id: input.producerSessionId,
        submission_id: input.submissionId
      },
      ...idempotent(input.idempotencyKey)
    }
  ))
}

export async function createRevisionRun(input: {
  outputId: string
  expectedOutputVersion: number
  producerSessionId: string
  idempotencyKey?: string
}): Promise<OutputRun> {
  return runFromWire(await operationsApi()<unknown>(
    `/meeting-outputs/${outputId(input.outputId)}/revision-runs`,
    {
      method: 'POST',
      body: {
        expected_output_version: input.expectedOutputVersion,
        producer_session_id: input.producerSessionId
      },
      ...idempotent(input.idempotencyKey)
    }
  ))
}

/** The dispatcher door. The returned cwd and collection claim are run-scoped
 *  secrets: never persist them, never render them, never log them. */
export async function claimOutputRun(input: {
  runId: string
  requestId: string
  sessionId: string
  kind?: 'production' | 'revision'
}): Promise<{
  runId: string
  outputId: string
  kind: string
  cwd: string
  collectionClaim: string
  brief: string
  briefHash: string
  acceptanceStatement: string
  parentArtifactVersion: number | null
  /** The session the server bound to this run (the first claim binds it). */
  sessionId: string
  /** Renewals > 0 means this run was claimed before: do NOT prompt again. */
  claimRenewals: number
}> {
  const base = input.kind === 'revision' ? '/meeting-output-revision-runs' : '/meeting-output-runs'

  const response = row(await operationsApi()<unknown>(`${base}/${outputId(input.runId)}/claim`, {
    method: 'POST',
    body: { request_id: input.requestId, session_id: input.sessionId }
  }))

  return {
    runId: text(response.run_id),
    outputId: text(response.output_id),
    kind: text(response.kind),
    cwd: text(row(response.workspace).cwd),
    collectionClaim: text(response.collection_claim),
    brief: text(response.brief),
    briefHash: text(response.brief_hash),
    acceptanceStatement: text(response.acceptance_statement),
    parentArtifactVersion: nullableCount(response.parent_artifact_version),
    sessionId: text(response.session_id),
    claimRenewals: count(row(response.claim).renewals)
  }
}

/** Claim a reviewer dispatch. The verdict route requires this durable claim,
 *  so an unclaimed review can never be verdicted. Reviewers never receive a
 *  writable path: the response is a read-only, server-prepared summary. */
export async function claimReviewRun(input: {
  requestId: string
  dispatchId: string
  sessionId: string
}): Promise<{ requestId: string; artifactVersion: number; reviewer: RouteIdentity }> {
  const response = row(await operationsApi()<unknown>(
    `/meeting-output-review-runs/${outputId(input.requestId)}/claim`,
    { method: 'POST', body: { request_id: input.dispatchId, session_id: input.sessionId } }
  ))

  return {
    requestId: text(response.request_id),
    artifactVersion: count(response.artifact_version),
    reviewer: routeFrom(response.reviewer)
  }
}

export async function collectOutputRun(input: {
  runId: string
  collectionClaim: string
  kind?: 'production' | 'revision'
  idempotencyKey?: string
}): Promise<{ receipt: CollectionReceipt; output: MeetingOutput; eligibility: OutputEligibility }> {
  const base = input.kind === 'revision' ? '/meeting-output-revision-runs' : '/meeting-output-runs'

  const response = row(await operationsApi()<unknown>(`${base}/${outputId(input.runId)}/collect`, {
    method: 'POST',
    body: { collection_claim: input.collectionClaim },
    ...idempotent(input.idempotencyKey)
  }))

  return {
    receipt: receiptFromWire(response.receipt),
    output: outputFromWire(response.output),
    eligibility: eligibilityFromWire(response.eligibility)
  }
}

export async function createReviewRun(input: {
  outputId: string
  expectedOutputVersion: number
  reviewer: RouteIdentity
  idempotencyKey?: string
}): Promise<{
  requestId: string
  artifactVersion: number
  checks: DeterministicChecks
  manifest: readonly ManifestFile[]
}> {
  const response = row(await operationsApi()<unknown>(
    `/meeting-outputs/${outputId(input.outputId)}/review-runs`,
    {
      method: 'POST',
      body: {
        expected_output_version: input.expectedOutputVersion,
        reviewer: routeToWire(input.reviewer)
      },
      ...idempotent(input.idempotencyKey)
    }
  ))

  return {
    requestId: text(response.request_id),
    artifactVersion: count(response.artifact_version),
    checks: checksFromWire(response.checks),
    manifest: Object.freeze(list(row(response.artifact_summary).files).map(manifestFileFromWire))
  }
}

export async function completeReviewRun(input: {
  requestId: string
  verdict: 'verified' | 'changes_requested'
  findings?: readonly ReviewFinding[]
  idempotencyKey?: string
}): Promise<{ review: ReviewRun; output: MeetingOutput; eligibility: OutputEligibility }> {
  const response = row(await operationsApi()<unknown>(
    `/meeting-output-review-runs/${outputId(input.requestId)}/complete`,
    {
      method: 'POST',
      body: {
        verdict: input.verdict,
        findings: (input.findings ?? []).map(finding => ({
          severity: finding.severity,
          code: finding.code,
          detail: finding.detail,
          ...(finding.path ? { path: finding.path } : {})
        }))
      },
      ...idempotent(input.idempotencyKey)
    }
  ))

  return {
    review: reviewRunFromWire(response.review),
    output: outputFromWire(response.output),
    eligibility: eligibilityFromWire(response.eligibility)
  }
}

/** The exact approval request. There is no approver or approval-time field:
 *  the server derives the owner from authentication and stamps the time. */
export async function approveMeetingOutput(input: {
  outputId: string
  meetingId: string
  expectedMeetingVersion: number
  expectedOutputVersion: number
  version: OutputVersion
  idempotencyKey?: string
}): Promise<{ output: MeetingOutput; eligibility: OutputEligibility; artifactBinding: Record<string, unknown> }> {
  const response = row(await operationsApi()<unknown>(
    `/meeting-outputs/${outputId(input.outputId)}/approve`,
    {
      method: 'POST',
      body: {
        meeting_id: input.meetingId,
        expected_meeting_version: input.expectedMeetingVersion,
        expected_output_version: input.expectedOutputVersion,
        artifact_version: artifactVersion(input.version.artifactVersion),
        game_sha256: input.version.gameSha256,
        manifest_sha256: input.version.manifestSha256,
        zip_sha256: input.version.zipSha256
      },
      ...idempotent(input.idempotencyKey)
    }
  ))

  return {
    output: outputFromWire(response.output),
    eligibility: eligibilityFromWire(response.eligibility),
    artifactBinding: row(response.artifact_binding)
  }
}

/** Realm-independent ArrayBuffer check. Bytes arrive over the Electron IPC
 *  structured clone, so `instanceof` against this realm's constructor is not
 *  reliable; the brand tag is. */
function isArrayBuffer(value: unknown): value is ArrayBuffer {
  return Boolean(value)
    && typeof (value as ArrayBuffer).byteLength === 'number'
    && Object.prototype.toString.call(value) === '[object ArrayBuffer]'
}

function binaryResponse(value: unknown): ArtifactBytes {
  const response = value as PluginBinaryResponse

  if (!response || !isArrayBuffer(response.bytes)) {
    throw new Error('The artifact response did not carry bytes.')
  }

  return {
    bytes: response.bytes,
    mediaType: String(response.mediaType ?? 'application/octet-stream'),
    sha256: String(response.headers?.['x-hermes-artifact-sha256'] ?? ''),
    status: Number(response.status ?? 200)
  }
}

/** Preview one declared member through the authenticated artifact endpoint.
 *  Package bytes never travel through the general local preview path. */
export async function previewOutputFile(input: {
  outputId: string
  artifactVersion: number
  path: string
}): Promise<ArtifactBytes> {
  const segments = input.path.split('/').map(segment => encodeURIComponent(segment)).join('/')

  return binaryResponse(await operationsApi()<unknown>(
    `/meeting-outputs/${outputId(input.outputId)}/versions/${artifactVersion(input.artifactVersion)}/files/${segments}`,
    { responseType: 'binary' }
  ))
}

export async function downloadOutputPackage(input: {
  outputId: string
  artifactVersion: number
}): Promise<ArtifactBytes> {
  return binaryResponse(await operationsApi()<unknown>(
    `/meeting-outputs/${outputId(input.outputId)}/versions/${artifactVersion(input.artifactVersion)}/download`,
    { responseType: 'binary' }
  ))
}

/** Recompute SHA-256 over downloaded bytes so the UI can prove the download
 *  equals the stored zip_sha256 rather than trusting the response header. */
export async function sha256Hex(bytes: ArrayBuffer): Promise<string> {
  const hashed = await crypto.subtle.digest('SHA-256', bytes)

  return [...new Uint8Array(hashed)].map(byte => byte.toString(16).padStart(2, '0')).join('')
}
