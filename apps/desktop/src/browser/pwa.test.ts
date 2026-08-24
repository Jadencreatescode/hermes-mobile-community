import { describe, expect, it, vi } from 'vitest'

import { bindMobileUpdatePrompt, MOBILE_UPDATE_READY_EVENT, registerMobileServiceWorker } from './pwa'

class FakeRegistration extends EventTarget {
  installing: null | (EventTarget & { state: string }) = null
  waiting: null | { postMessage: (message: unknown) => void } = null
}

describe('mobile service worker registration', () => {
  it('registers the scoped worker without activating it over an active client', async () => {
    const registration = new FakeRegistration()
    const register = vi.fn(async () => registration)
    const eventTarget = new EventTarget()
    const updateReady = vi.fn()
    eventTarget.addEventListener(MOBILE_UPDATE_READY_EVENT, updateReady)

    await registerMobileServiceWorker({
      eventTarget,
      serviceWorker: { controller: {}, register } as unknown as ServiceWorkerContainer
    })

    expect(register).toHaveBeenCalledWith('./service-worker.js', { scope: './' })
    expect(updateReady).not.toHaveBeenCalled()
  })

  it('announces a waiting update without forcing a reload', async () => {
    const registration = new FakeRegistration()
    registration.waiting = { postMessage: vi.fn() }
    const eventTarget = new EventTarget()
    const updateReady = vi.fn()
    eventTarget.addEventListener(MOBILE_UPDATE_READY_EVENT, updateReady)

    await registerMobileServiceWorker({
      eventTarget,
      serviceWorker: {
        controller: {},
        register: vi.fn(async () => registration)
      } as unknown as ServiceWorkerContainer
    })

    expect(updateReady).toHaveBeenCalledTimes(1)
    expect(registration.waiting.postMessage).not.toHaveBeenCalled()
  })

  it('reloads only after the user activates a waiting worker and control changes', () => {
    const eventTarget = new EventTarget()
    const serviceWorker = new EventTarget() as EventTarget & { controller: object }
    serviceWorker.controller = {}
    const reload = vi.fn()
    const notify = vi.fn()
    const waiting = { postMessage: vi.fn() }
    const registration = { waiting } as unknown as ServiceWorkerRegistration
    bindMobileUpdatePrompt({ eventTarget, notify, reload, serviceWorker: serviceWorker as unknown as ServiceWorkerContainer })

    eventTarget.dispatchEvent(new CustomEvent(MOBILE_UPDATE_READY_EVENT, { detail: { registration } }))
    const action = notify.mock.calls[0][0].action
    action.onClick()

    expect(waiting.postMessage).toHaveBeenCalledWith({ type: 'SKIP_WAITING' })
    expect(reload).not.toHaveBeenCalled()
    serviceWorker.dispatchEvent(new Event('controllerchange'))
    expect(reload).toHaveBeenCalledTimes(1)
  })
})
