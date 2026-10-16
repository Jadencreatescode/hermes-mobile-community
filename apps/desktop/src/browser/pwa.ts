export const MOBILE_UPDATE_READY_EVENT = 'hermes-mobile-update-ready'

interface MobileServiceWorkerOptions {
  eventTarget?: EventTarget
  serviceWorker?: ServiceWorkerContainer
}

interface MobileUpdatePromptOptions {
  eventTarget?: EventTarget
  notify: (input: {
    action: { label: string; onClick: () => void }
    durationMs: number
    id: string
    kind: 'info'
    message: string
    title: string
  }) => unknown
  reload?: () => void
  serviceWorker?: ServiceWorkerContainer
}

function announceWaitingUpdate(eventTarget: EventTarget, registration: ServiceWorkerRegistration): void {
  eventTarget.dispatchEvent(
    new CustomEvent(MOBILE_UPDATE_READY_EVENT, {
      detail: { registration }
    })
  )
}

export async function registerMobileServiceWorker(
  options: MobileServiceWorkerOptions = {}
): Promise<ServiceWorkerRegistration | null> {
  const serviceWorker = options.serviceWorker ?? navigator.serviceWorker
  const eventTarget = options.eventTarget ?? window

  if (!serviceWorker?.register) {
    return null
  }

  const registration = await serviceWorker.register('./service-worker.js', { scope: './' })

  if (registration.waiting && serviceWorker.controller) {
    announceWaitingUpdate(eventTarget, registration)
  }

  registration.addEventListener('updatefound', () => {
    const installing = registration.installing

    if (!installing) {
      return
    }

    installing.addEventListener('statechange', () => {
      if (installing.state === 'installed' && serviceWorker.controller) {
        announceWaitingUpdate(eventTarget, registration)
      }
    })
  })

  return registration
}

export function activateWaitingMobileUpdate(registration: ServiceWorkerRegistration): boolean {
  if (!registration.waiting) {
    return false
  }

  registration.waiting.postMessage({ type: 'SKIP_WAITING' })

  return true
}

export function bindMobileUpdatePrompt(options: MobileUpdatePromptOptions): () => void {
  const eventTarget = options.eventTarget ?? window
  const serviceWorker = options.serviceWorker ?? navigator.serviceWorker
  const reload = options.reload ?? (() => window.location.reload())

  const onUpdateReady = (event: Event) => {
    const registration = (event as CustomEvent<{ registration?: ServiceWorkerRegistration }>).detail?.registration

    if (!registration?.waiting) {
      return
    }

    options.notify({
      action: {
        label: 'Reload',
        onClick: () => {
          serviceWorker.addEventListener('controllerchange', reload, { once: true })
          activateWaitingMobileUpdate(registration)
        }
      },
      durationMs: 0,
      id: 'hermes-mobile-update-ready',
      kind: 'info',
      message: 'Reload when you are ready. Your current turn will not be interrupted.',
      title: 'A new Hermes interface is ready'
    })
  }

  eventTarget.addEventListener(MOBILE_UPDATE_READY_EVENT, onUpdateReady)

  return () => eventTarget.removeEventListener(MOBILE_UPDATE_READY_EVENT, onUpdateReady)
}
