import {
  Button,
  Codicon,
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  Input,
  Loader
} from '@hermes/plugin-sdk'
import { useCallback, useEffect, useMemo, useState } from 'react'

import {
  createBot,
  HARNESS_INSTALL_COMMANDS,
  loadMakeBotState,
  type MakeBotModel,
  type MakeBotState
} from './make-bot-data'

export interface MakeBotDialogProps {
  open: boolean
  onCreated?: (name: string) => void
  onOpenChange: (open: boolean) => void
}

const BOT_NAME_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/

function nameError(value: string): string | null {
  const trimmed = value.trim()

  if (!trimmed) {return 'Give this Bot a name.'}

  if (!BOT_NAME_PATTERN.test(trimmed)) {
    return 'Use lowercase letters, numbers, dashes, or underscores, starting with a letter or number.'
  }

  return null
}

function Field({ children, hint, label }: { children: React.ReactNode; hint?: string; label: string }) {
  return (
    <label className="flex min-w-0 flex-col gap-1.5">
      <span className="text-xs font-semibold text-(--ui-text-secondary)">{label}</span>
      {children}
      {hint ? <span className="text-[0.68rem] text-(--ui-text-tertiary)">{hint}</span> : null}
    </label>
  )
}

function groupModelsByProvider(models: MakeBotModel[]): Map<string, MakeBotModel[]> {
  const groups = new Map<string, MakeBotModel[]>()

  for (const model of models) {
    const list = groups.get(model.provider) ?? []
    list.push(model)
    groups.set(model.provider, list)
  }

  return groups
}

export function MakeBotDialog({ open, onCreated, onOpenChange }: MakeBotDialogProps) {
  const [state, setState] = useState<MakeBotState | null>(null)
  const [loading, setLoading] = useState(false)
  const [name, setName] = useState('')
  const [harness, setHarness] = useState('')
  const [model, setModel] = useState('')
  const [creating, setCreating] = useState(false)
  const [error, setError] = useState('')

  const load = useCallback(async () => {
    setLoading(true)
    setError('')

    try {
      const next = await loadMakeBotState()
      setState(next)
      setHarness(next.harnesses[0]?.id ?? '')
      setModel(next.models[0]?.id ?? '')
    } catch {
      setState({ degraded: true, degradedReason: 'no_machine', harnesses: [], models: [] })
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (!open) {return}
    setName('')
    setHarness('')
    setModel('')
    setError('')
    setCreating(false)
    void load()
  }, [open, load])

  const handleClose = useCallback((next: boolean) => {
    onOpenChange(next)
  }, [onOpenChange])

  const nameErr = useMemo(() => nameError(name), [name])

  const providerGroups = useMemo(() => {
    if (!state) {return new Map<string, MakeBotModel[]>()}

    return groupModelsByProvider(state.models)
  }, [state])

  const selectedHarness = state?.harnesses.find(h => h.id === harness)

  const submit = useCallback(async () => {
    if (nameErr || creating || !state) {return}
    setCreating(true)
    setError('')

    try {
      const result = await createBot({
        name: name.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64),
        harness: harness || undefined,
        model: model || undefined
      })

      onCreated?.(result.name)
      handleClose(false)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'This Bot could not be created.')
    } finally {
      setCreating(false)
    }
  }, [nameErr, creating, state, name, harness, model, onCreated, handleClose])

  return (
    <Dialog onOpenChange={handleClose} open={open}>
      <DialogContent
        className="max-h-[calc(100dvh-2rem)] w-[calc(100vw-1rem)] max-w-2xl overflow-y-auto p-0 sm:w-[calc(100vw-2rem)]"
        showCloseButton={false}
      >
        <DialogHeader className="border-b border-(--ui-stroke-tertiary) px-4 py-3">
          <DialogTitle className="text-base font-semibold text-(--ui-text-primary)">Make a Bot</DialogTitle>
        </DialogHeader>

        <div className="flex min-w-0 flex-col gap-4 px-4 py-4">
          {loading || !state ? (
            <div className="grid min-h-32 place-items-center">
              <Loader label="Reading catalog" type="lemniscate-bloom" />
            </div>
          ) : state.degraded && state.degradedReason === 'no_harness' ? (
            <div className="space-y-3">
              <p className="text-sm text-(--ui-text-secondary)">No harnesses detected on this machine.</p>
              <p className="text-xs text-(--ui-text-tertiary)">
                Install a supported harness CLI and check again. Hermes will never auto-install a harness.
              </p>
              <div className="space-y-2 rounded-lg border border-(--ui-stroke-tertiary) bg-(--ui-surface-secondary) p-3">
                <p className="text-xs font-semibold text-(--ui-text-secondary)">Suggested commands</p>
                {Object.entries(HARNESS_INSTALL_COMMANDS).map(([id, cmd]) => (
                  <div className="flex min-w-0 items-center justify-between gap-2" key={id}>
                    <code className="min-w-0 truncate text-xs text-(--ui-text-primary)">{cmd}</code>
                    <CopyButton text={cmd} />
                  </div>
                ))}
              </div>
              <div className="flex justify-end gap-2">
                <Button className="min-h-11" onClick={() => handleClose(false)} size="sm" variant="ghost">Cancel</Button>
                <Button className="min-h-11" onClick={() => void load()} size="sm">
                  <Codicon name="refresh" /> Check again
                </Button>
              </div>
            </div>
          ) : state.degraded && state.degradedReason === 'no_model' ? (
            <div className="space-y-3">
              <p className="text-sm text-(--ui-text-secondary)">No models available.</p>
              <p className="text-xs text-(--ui-text-tertiary)">
                Add a provider and model in Settings so this Bot knows what to run.
              </p>
              <div className="flex justify-end gap-2">
                <Button className="min-h-11" onClick={() => handleClose(false)} size="sm" variant="ghost">Cancel</Button>
                <Button className="min-h-11" onClick={() => void load()} size="sm">
                  <Codicon name="refresh" /> Check again
                </Button>
              </div>
            </div>
          ) : state.degraded && state.degradedReason === 'no_machine' ? (
            <div className="space-y-3">
              <p className="text-sm text-(--ui-text-secondary)">This machine could not be reached.</p>
              <p className="text-xs text-(--ui-text-tertiary)">
                Make sure Hermes is running and try again.
              </p>
              <div className="flex justify-end gap-2">
                <Button className="min-h-11" onClick={() => handleClose(false)} size="sm" variant="ghost">Cancel</Button>
                <Button className="min-h-11" onClick={() => void load()} size="sm">
                  <Codicon name="refresh" /> Check again
                </Button>
              </div>
            </div>
          ) : (
            <>
              <div className="grid min-w-0 gap-3">
                <Field hint="Lowercase letters, numbers, dashes, underscores." label="Bot name">
                  <Input
                    aria-label="Bot name"
                    className="min-h-11"
                    onChange={event => {
                      setName(event.target.value)
                      setError('')
                    }}
                    placeholder="research-lead"
                    value={name}
                  />
                </Field>
              </div>

              <div className="grid min-w-0 gap-3 sm:grid-cols-2">
                <Field hint="The machine that keeps this Bot and runs it." label="Machine">
                  <select
                    aria-label="Machine"
                    className="min-h-11 min-w-0 rounded-lg border border-(--ui-stroke-tertiary) bg-transparent px-3 text-sm text-(--ui-text-primary)"
                    disabled
                    value="local"
                  >
                    <option value="local">This machine</option>
                  </select>
                </Field>

                <Field hint="The harness this Bot uses to run." label="Harness">
                  <select
                    aria-label="Harness"
                    className="min-h-11 min-w-0 rounded-lg border border-(--ui-stroke-tertiary) bg-transparent px-3 text-sm text-(--ui-text-primary)"
                    onChange={event => setHarness(event.target.value)}
                    value={harness}
                  >
                    {state.harnesses.map(h => (
                      <option key={h.id} value={h.id}>{h.label}</option>
                    ))}
                  </select>
                  {selectedHarness ? (
                    <span className="text-xs text-(--ui-text-tertiary)">
                      {selectedHarness.detected ? 'Detected' : 'Not detected'} · {selectedHarness.source}
                    </span>
                  ) : null}
                </Field>
              </div>

              <Field hint="The model this Bot runs." label="Model">
                <select
                  aria-label="Model"
                  className="min-h-11 min-w-0 rounded-lg border border-(--ui-stroke-tertiary) bg-transparent px-3 text-sm text-(--ui-text-primary)"
                  onChange={event => setModel(event.target.value)}
                  value={model}
                >
                  {Array.from(providerGroups.entries()).map(([provider, models]) => (
                    <optgroup key={provider} label={provider}>
                      {models.map(m => (
                        <option key={m.id} value={m.id}>{m.label}</option>
                      ))}
                    </optgroup>
                  ))}
                </select>
              </Field>

              {nameErr ? (
                <p className="text-xs text-destructive" role="alert">{nameErr}</p>
              ) : null}
              {error ? (
                <p className="text-xs text-destructive" role="alert">{error}</p>
              ) : null}

              <div className="flex flex-wrap items-center justify-between gap-2 border-t border-(--ui-stroke-tertiary) pt-3">
                <p className="min-w-0 text-[0.68rem] text-(--ui-text-tertiary)">
                  {nameErr || 'Created on this machine.'}
                </p>
                <div className="flex shrink-0 items-center gap-2">
                  <Button className="min-h-11" onClick={() => handleClose(false)} size="sm" variant="ghost">Cancel</Button>
                  <Button className="min-h-11" disabled={Boolean(nameErr) || creating} onClick={() => void submit()} size="sm">
                    <Codicon className={creating ? 'animate-spin' : ''} name={creating ? 'sync' : 'check'} />
                    {creating ? 'Creating…' : 'Create Bot'}
                  </Button>
                </div>
              </div>
            </>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false)

  const handleClick = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 2000)
    } catch {
      // ignore
    }
  }, [text])

  return (
    <Button aria-label="Copy command" className="h-7 px-2 text-xs" onClick={handleClick} size="sm" variant="ghost">
      <Codicon name={copied ? 'check' : 'copy'} size="0.875rem" />
    </Button>
  )
}
