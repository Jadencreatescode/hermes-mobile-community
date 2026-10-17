// The DeliverablePackage output panel.
//
// This surface shows lifecycle TRUTH and nothing else. Every hash, every
// version, every finding, and the approver label come from the server; the
// panel has no hash field, no approver field, and no approval-time field. The
// action buttons appear only when the server's own eligibility flags say so,
// so a stale render can never offer an action the backend would refuse.

import { Button, Codicon, host } from '@hermes/plugin-sdk'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import {
  approveMeetingOutput,
  type ArtifactBytes,
  downloadOutputPackage,
  getMeetingOutput,
  isInlinePreviewable,
  type ManifestFile,
  type MeetingOutputDetail,
  type OutputVersion,
  previewOutputFile,
  type ReviewFinding,
  sha256Hex,
  versionLineage
} from './deliverable-package'
import type { MeetingRecord, RouteIdentity } from './meetings'

const OUTPUT_STATE_LABELS: Record<string, string> = {
  candidate: 'Candidate',
  reviewing: 'Awaiting review',
  changes_requested: 'Changes requested',
  verified: 'Verified',
  approved: 'Approved'
}

const STAGE_LABELS: Record<string, string> = {
  briefing: 'Briefing',
  working: 'Working',
  production_ready: 'Ready to produce',
  producing: 'Producing',
  reviewing: 'In review',
  changes_requested: 'Changes requested',
  approval_ready: 'Ready for approval',
  completed: 'Completed'
}

const SEVERITY_TONE: Record<ReviewFinding['severity'], string> = {
  low: 'bg-white/10 text-white/80',
  medium: 'bg-amber-300/15 text-amber-100',
  high: 'bg-orange-400/15 text-orange-100',
  critical: 'bg-red-500/20 text-red-100'
}

function shortDigest(value: string): string {
  return value ? `${value.slice(0, 12)}…${value.slice(-8)}` : '—'
}

function byteLabel(value: number): string {
  if (value < 1024) {return `${value} B`}

  if (value < 1024 * 1024) {return `${(value / 1024).toFixed(1)} KiB`}

  return `${(value / (1024 * 1024)).toFixed(1)} MiB`
}

/** The independent reviewer seats the server would accept. */
export function reviewerCandidates(meeting: MeetingRecord): RouteIdentity[] {
  const excluded = new Set(
    [meeting.orchestrator, meeting.producer]
      .filter(Boolean)
      .map(route => `${route!.connectionId}::${route!.profile}`)
  )

  return (meeting.seats ?? [])
    .filter(seat => seat.role === 'reviewer' && !excluded.has(`${seat.bot.connectionId}::${seat.bot.profile}`))
    .map(seat => seat.bot)
}

function DigestRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex min-w-0 items-baseline gap-2">
      <dt className="w-28 shrink-0 text-[0.65rem] uppercase tracking-wide text-(--ui-text-tertiary)">{label}</dt>
      <dd className="min-w-0 truncate font-mono text-xs text-(--ui-text-secondary)" title={value}>
        {shortDigest(value)}
      </dd>
    </div>
  )
}

// health: allow CC -- retained deliverable lifecycle UI is migration scoped and contract tested
export function DeliverablePackageOutput({
  detail,
  meeting,
  meetingVersion,
  onChanged,
  onReview,
  onRevise
}: {
  detail: MeetingOutputDetail
  meeting: MeetingRecord
  meetingVersion: number
  onChanged?: () => void | Promise<void>
  /** Dispatches the independent reviewer Bot and records only that Bot's
   * verdict. Without this callback no review action is exposed. */
  onReview?: () => Promise<string | void>
  /** Runs the real revision dispatch (new run -> producer session -> claim ->
   *  prompt -> collect). Without it there is no reachable collect path for a
   *  revision, so the Revise action stays hidden rather than opening a run
   *  nothing can finish. */
  onRevise?: () => Promise<string | void>
}) {
  const { eligibility, output, reviews, versions } = detail
  const lineage = useMemo(() => versionLineage(versions), [versions])
  const [selectedVersion, setSelectedVersion] = useState(() => output.currentArtifactVersion)
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [preview, setPreview] = useState<{ file: ManifestFile; text: string } | null>(null)
  const generation = useRef(0)

  const reviewers = useMemo(() => reviewerCandidates(meeting), [meeting])

  const version: OutputVersion | undefined = useMemo(
    () => lineage.find(row => row.artifactVersion === selectedVersion) ?? lineage[lineage.length - 1],
    [lineage, selectedVersion]
  )

  const openReview = reviews.find(row => row.state === 'open')
  const latestReview = reviews[0]

  useEffect(() => {
    // Follow the server's current version when a new one is collected, but
    // never clobber a version the user deliberately selected for inspection.
    setSelectedVersion(current =>
      lineage.some(row => row.artifactVersion === current) ? current : output.currentArtifactVersion
    )
  }, [lineage, output.currentArtifactVersion])

  useEffect(() => {
    setPreview(null)
  }, [selectedVersion])

  const run = useCallback(async (label: string, action: () => Promise<string>) => {
    const token = ++generation.current
    setBusy(label)
    setError('')
    setNotice('')

    try {
      const message = await action()

      if (token !== generation.current) {return}
      setNotice(message)
      await onChanged?.()
    } catch (cause) {
      if (token !== generation.current) {return}
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      if (token === generation.current) {setBusy('')}
    }
  }, [onChanged])

  const review = () => void run('review', async () => {
    if (!onReview) {
      throw new Error('Independent reviewer dispatch is unavailable in this view.')
    }

    return (await onReview()) || 'Independent review completed.'
  })

  const revise = () => void run('revise', async () => {
    if (!onRevise) {
      throw new Error('Revision dispatch is unavailable in this view.')
    }

    return (await onRevise()) || 'Revision collected.'
  })

  const approve = () => void run('approve', async () => {
    // Re-read first: approval must echo the server's CURRENT versions and
    // hashes, so a stale panel produces a 409 instead of a wrong approval.
    const fresh = await getMeetingOutput(output.outputId)

    const target = fresh.versions.find(
      row => row.artifactVersion === fresh.output.verifiedArtifactVersion
    )

    if (!target) {
      throw new Error('There is no verified artifact version to approve.')
    }

    const approved = await approveMeetingOutput({
      outputId: output.outputId,
      meetingId: output.meetingId,
      expectedMeetingVersion: meetingVersion,
      expectedOutputVersion: fresh.output.version,
      version: target,
      // Bound to the exact artifact version and the versions this approval was
      // built against, so a double click replays and a stale panel conflicts.
      idempotencyKey: `approve-${output.outputId}-${fresh.output.version}-${target.artifactVersion}`
    })

    return `Artifact version ${approved.output.approvedArtifactVersion} approved by ${
      String(approved.artifactBinding.approved_by ?? 'Owner')
    }.`
  })

  const previewFile = (file: ManifestFile) => void run('preview', async () => {
    if (!version) {throw new Error('Select an artifact version first.')}

    const bytes = await previewOutputFile({
      outputId: output.outputId,
      artifactVersion: version.artifactVersion,
      path: file.path
    })

    if (file.previewPolicy !== 'text') {
      // Image and download-only members are never rendered as text here; the
      // panel keeps download as the honest affordance.
      setPreview(null)

      return `${file.path} is download-only in this panel (${file.previewPolicy}).`
    }

    setPreview({ file, text: new TextDecoder().decode(bytes.bytes) })

    return `${file.path} previewed (${shortDigest(bytes.sha256)}).`
  })

  const download = (target: OutputVersion) => void run('download', async () => {
    const bytes: ArtifactBytes = await downloadOutputPackage({
      outputId: output.outputId,
      artifactVersion: target.artifactVersion
    })

    const recomputed = await sha256Hex(bytes.bytes)

    if (recomputed !== target.zipSha256) {
      throw new Error('The downloaded package does not match the stored zip_sha256.')
    }

    host.notify({
      kind: 'success',
      message: `Deliverable v${target.artifactVersion} verified against zip_sha256`
    })

    return `Downloaded ${byteLabel(bytes.bytes.byteLength)} and verified against zip_sha256.`
  })

  return (
    <section
      aria-label="Deliverable package output"
      className="min-w-0 space-y-4 rounded-[1.25rem] border border-white/10 bg-slate-950/70 p-4"
      data-output-state={output.state}
      data-testid="deliverable-package-output"
    >
      <header className="flex min-w-0 flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-[0.62rem] font-semibold uppercase tracking-[0.16em] text-cyan-300">
            Deliverable package
          </p>
          <h3 className="truncate text-sm font-semibold text-white">{output.title}</h3>
          <p className="mt-1 text-xs text-white/60">
            {output.productKind} · {output.kind}
          </p>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1">
          <span
            className="rounded-full bg-white/10 px-2.5 py-1 text-[0.65rem] font-semibold text-white"
            data-testid="output-state"
            role="status"
          >
            {OUTPUT_STATE_LABELS[output.state] ?? output.state}
          </span>
          {meeting.productionStage ? (
            <span className="text-[0.65rem] text-white/60" data-testid="production-stage">
              Stage: {STAGE_LABELS[meeting.productionStage] ?? meeting.productionStage}
            </span>
          ) : null}
        </div>
      </header>

      <section aria-label="Acceptance statement">
        <h4 className="text-[0.62rem] font-semibold uppercase tracking-wide text-(--ui-text-tertiary)">
          Acceptance
        </h4>
        <p className="mt-1 text-xs leading-5 text-white/75">{output.summary}</p>
      </section>

      {lineage.length ? (
        <section aria-label="Artifact versions" className="space-y-2">
          <h4 className="text-[0.62rem] font-semibold uppercase tracking-wide text-(--ui-text-tertiary)">
            Immutable versions
          </h4>
          <div className="flex min-w-0 flex-wrap gap-1.5" role="group">
            {lineage.map(row => (
              <button
                aria-current={row.artifactVersion === version?.artifactVersion ? 'true' : undefined}
                aria-label={`Artifact version ${row.artifactVersion}${
                  row.parentArtifactVersion ? `, revised from ${row.parentArtifactVersion}` : ''
                }`}
                className={`min-h-9 rounded-full px-3 text-xs font-semibold transition-colors ${
                  row.artifactVersion === version?.artifactVersion
                    ? 'bg-cyan-300 text-slate-950'
                    : 'bg-white/5 text-white/75 hover:bg-white/10'
                }`}
                key={row.artifactVersion}
                onClick={() => setSelectedVersion(row.artifactVersion)}
                type="button"
              >
                v{row.artifactVersion}
                {row.artifactVersion === output.approvedArtifactVersion ? ' ✓' : ''}
              </button>
            ))}
          </div>
          {version ? (
            <div className="space-y-2 rounded-xl border border-white/10 bg-black/30 p-3">
              <dl className="space-y-1">
                <DigestRow label="game_sha256" value={version.gameSha256} />
                <DigestRow label="manifest_sha256" value={version.manifestSha256} />
                <DigestRow label="zip_sha256" value={version.zipSha256} />
              </dl>
              <p className="text-[0.65rem] text-white/55" data-testid="version-lineage">
                {version.parentArtifactVersion
                  ? `Revised from artifact version ${version.parentArtifactVersion}`
                  : 'Lineage root'}
                {' · '}
                {byteLabel(version.totalByteSize)}
                {' · '}
                primary {version.manifest.primaryFile}
              </p>
            </div>
          ) : null}
        </section>
      ) : (
        <p className="text-xs text-white/60" data-testid="no-artifact-yet">
          No artifact version has been collected yet.
        </p>
      )}

      {version?.manifest.files.length ? (
        <section aria-label="Manifest files" className="space-y-1">
          <h4 className="text-[0.62rem] font-semibold uppercase tracking-wide text-(--ui-text-tertiary)">
            Manifest
          </h4>
          <ul className="space-y-1">
            {version.manifest.files.map(file => (
              <li className="flex min-w-0 items-center gap-2 text-xs" key={file.path}>
                <span className="min-w-0 flex-1 truncate font-mono text-white/80" title={file.path}>
                  {file.path}
                </span>
                <span className="shrink-0 text-white/50">{byteLabel(file.byteSize)}</span>
                <span className="shrink-0 rounded-full bg-white/10 px-2 py-0.5 text-[0.6rem] text-white/70">
                  {file.previewPolicy}
                </span>
                {eligibility.preview && isInlinePreviewable(file) ? (
                  <Button
                    aria-label={`Preview ${file.path}`}
                    className="min-h-9 shrink-0 px-2 text-[0.65rem]"
                    disabled={Boolean(busy)}
                    onClick={() => previewFile(file)}
                    variant="ghost"
                  >
                    Preview
                  </Button>
                ) : (
                  <span className="shrink-0 text-[0.6rem] text-white/40">download only</span>
                )}
              </li>
            ))}
          </ul>
          {preview ? (
            <pre
              aria-label={`Preview of ${preview.file.path}`}
              className="max-h-48 overflow-auto rounded-lg border border-white/10 bg-black/50 p-2 text-[0.7rem] text-white/80"
              data-testid="member-preview"
            >
              {preview.text}
            </pre>
          ) : null}
        </section>
      ) : null}

      {output.findings.length ? (
        <section aria-label="Review findings" className="space-y-1">
          <h4 className="text-[0.62rem] font-semibold uppercase tracking-wide text-(--ui-text-tertiary)">
            Findings
          </h4>
          <ul className="space-y-1">
            {output.findings.map((finding, index) => (
              <li className="flex min-w-0 items-start gap-2 text-xs" key={`${finding.code}-${index}`}>
                <span className={`shrink-0 rounded-full px-2 py-0.5 text-[0.6rem] font-semibold ${SEVERITY_TONE[finding.severity]}`}>
                  {finding.severity}
                </span>
                <span className="min-w-0 text-white/75">
                  <span className="font-mono text-white/60">{finding.code}</span>
                  {' — '}
                  {finding.detail}
                  {finding.path ? <span className="text-white/50"> ({finding.path})</span> : null}
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {latestReview ? (
        <section aria-label="Review history" className="text-[0.65rem] text-white/55" data-testid="review-history">
          Latest review: v{latestReview.artifactVersion} ·{' '}
          {latestReview.state === 'open' ? 'open' : latestReview.verdict || 'completed'} ·{' '}
          reviewer {latestReview.reviewer.profile}
          {latestReview.checks.failedChecks.length
            ? ` · failed checks: ${latestReview.checks.failedChecks.join(', ')}`
            : ''}
        </section>
      ) : null}

      <div aria-label="Output actions" className="flex min-w-0 flex-wrap items-center gap-2">
        {(eligibility.review || Boolean(openReview)) && onReview ? (
          <Button
            aria-label={openReview ? 'Resume independent review' : 'Start independent review'}
            className="min-h-11"
            disabled={Boolean(busy) || !reviewers.length}
            onClick={review}
          >
            <Codicon name="search" /> {openReview ? 'Resume review' : 'Review'}
          </Button>
        ) : null}

        {eligibility.revise && onRevise ? (
          <Button aria-label="Start a revision" className="min-h-11" disabled={Boolean(busy)} onClick={revise}>
            <Codicon name="sync" /> Revise
          </Button>
        ) : null}

        {eligibility.approve ? (
          <Button
            aria-label="Approve this artifact version"
            className="min-h-11 bg-emerald-300 text-slate-950 hover:bg-emerald-200"
            disabled={Boolean(busy)}
            onClick={approve}
          >
            <Codicon name="verified" /> Approve
          </Button>
        ) : null}

        {eligibility.download && version ? (
          <Button
            aria-label={`Download artifact version ${version.artifactVersion}`}
            className="min-h-11"
            disabled={Boolean(busy)}
            onClick={() => download(version)}
            variant="outline"
          >
            <Codicon name="cloud-download" /> Download
          </Button>
        ) : null}
      </div>

      {busy ? (
        <p className="text-xs text-white/60" data-testid="output-busy" role="status">Working…</p>
      ) : null}
      {notice ? (
        <p className="text-xs text-emerald-200" data-testid="output-notice" role="status">{notice}</p>
      ) : null}
      {error ? (
        <p className="text-xs text-red-300" data-testid="output-error" role="alert">{error}</p>
      ) : null}
    </section>
  )
}
