import {
  Button,
  Codicon,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input
} from '@hermes/plugin-sdk'
import { useCallback, useState } from 'react'

import { registerA2AAgent, type HarnessAgent } from './data'

export interface TrustedBridgeOnboardingProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onRegistered?: (agent: HarnessAgent) => void
}

type Step = 'paste' | 'review' | 'confirming' | 'done'

export function TrustedBridgeOnboarding({ open, onOpenChange, onRegistered }: TrustedBridgeOnboardingProps) {
  const [url, setUrl] = useState('')
  const [step, setStep] = useState<Step>('paste')
  const [preview, setPreview] = useState<HarnessAgent | null>(null)
  const [error, setError] = useState('')

  const reset = useCallback(() => {
    setUrl('')
    setStep('paste')
    setPreview(null)
    setError('')
  }, [])

  const handleClose = useCallback(
    (next: boolean) => {
      onOpenChange(next)
      if (!next) {
        window.setTimeout(reset, 300)
      }
    },
    [onOpenChange, reset]
  )

  const handleReview = useCallback(async () => {
    setError('')
    setStep('review')

    try {
      const agent = await registerA2AAgent(url, false)
      setPreview(agent)
    } catch (cause) {
      setStep('paste')
      setError(cause instanceof Error ? cause.message : 'Could not review endpoint')
    }
  }, [url])

  const handleConfirm = useCallback(async () => {
    setError('')
    setStep('confirming')

    try {
      const agent = await registerA2AAgent(url, true)
      setPreview(agent)
      setStep('done')
      onRegistered?.(agent)
    } catch (cause) {
      setStep('review')
      setError(cause instanceof Error ? cause.message : 'Registration failed')
    }
  }, [url, onRegistered])

  const canReview = url.trim().length > 0 && url.trim().length <= 2048 && url.trim().startsWith('https://')

  return (
    <Dialog onOpenChange={handleClose} open={open}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Connect A2A agent</DialogTitle>
          <DialogDescription>Paste an agent card URL to review and connect a trusted bridge.</DialogDescription>
        </DialogHeader>

        {step === 'paste' || step === 'review' ? (
          <div className="space-y-3">
            <label className="block text-sm font-medium" htmlFor="a2a-url">
              Agent card URL
            </label>
            <Input
              disabled={step === 'review'}
              id="a2a-url"
              onChange={event => setUrl(event.target.value)}
              placeholder="https://example.com/agent.json"
              value={url}
            />
            {error && (
              <p className="flex items-center gap-1 text-xs text-destructive" role="alert">
                <Codicon name="error" size="0.875rem" />
                {error}
              </p>
            )}
          </div>
        ) : null}

        {step === 'review' && preview && (
          <div className="space-y-2 rounded-lg border border-(--ui-stroke-secondary) bg-(--ui-chat-surface-background) p-3">
            <p className="text-sm font-medium">{preview.name || 'Unknown agent'}</p>
            <p className="text-xs text-(--ui-text-secondary)">ID: {preview.agentId}</p>
            {preview.capabilities.length > 0 && (
              <p className="text-xs text-(--ui-text-tertiary)">Capabilities: {preview.capabilities.join(', ')}</p>
            )}
            <p className="text-xs text-(--ui-text-tertiary)">Status: {preview.status}</p>
          </div>
        )}

        {step === 'confirming' && (
          <div className="flex items-center gap-2 py-4 text-sm text-(--ui-text-secondary)">
            <Codicon className="animate-spin" name="loading" />
            Confirming connection…
          </div>
        )}

        {step === 'done' && preview && (
          <div className="flex items-center gap-2 py-4 text-sm text-green-400" role="status">
            <Codicon name="check" />
            Connected {preview.name}
          </div>
        )}

        <DialogFooter>
          {step === 'paste' && (
            <>
              <Button onClick={() => handleClose(false)} variant="ghost">
                Cancel
              </Button>
              <Button disabled={!canReview} onClick={handleReview}>
                Review endpoint
              </Button>
            </>
          )}
          {step === 'review' && (
            <>
              <Button onClick={() => setStep('paste')} variant="ghost">
                Back
              </Button>
              <Button disabled={!preview} onClick={handleConfirm}>
                Confirm and connect
              </Button>
            </>
          )}
          {(step === 'confirming' || step === 'done') && (
            <Button disabled={step === 'confirming'} onClick={() => handleClose(false)}>
              Close
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
