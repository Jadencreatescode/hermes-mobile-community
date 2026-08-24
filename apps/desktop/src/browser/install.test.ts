import { afterEach, describe, expect, it, vi } from 'vitest'

const desktopWindow = window as unknown as { hermesDesktop?: Window['hermesDesktop'] }
const originalBridge = desktopWindow.hermesDesktop
const originalBody = document.body.innerHTML

afterEach(() => {
  desktopWindow.hermesDesktop = originalBridge
  document.body.innerHTML = originalBody
  delete document.documentElement.dataset.hermesBrowserConfigError
  vi.resetModules()
})

describe('browser bridge installer', () => {
  it('installs the browser bridge as an entrypoint side effect when Electron is absent', async () => {
    delete desktopWindow.hermesDesktop
    vi.spyOn(window, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ version: 1, backend: { id: 'local', label: 'Local Hermes' } }), {
        headers: { 'content-type': 'application/json' }
      })
    )

    await import('./install')

    const installed = (window as unknown as { hermesDesktop?: Window['hermesDesktop'] }).hermesDesktop
    expect(installed?.getConnection).toBeTypeOf('function')
    expect(installed?.api).toBeTypeOf('function')
    expect(window.fetch).toHaveBeenCalledWith(
      `${window.location.origin}/.well-known/hermes-mobile-runtime.json`,
      expect.objectContaining({ credentials: 'include' })
    )
  })

  it('fails closed with a visible setup error when relay configuration is unavailable', async () => {
    delete desktopWindow.hermesDesktop
    document.body.innerHTML = '<div id="root"></div>'
    vi.spyOn(window, 'fetch').mockResolvedValue(new Response('missing', { status: 404 }))

    await expect(import('./install')).rejects.toThrow(/runtime descriptor/i)

    expect(desktopWindow.hermesDesktop).toBeUndefined()
    expect(document.documentElement.dataset.hermesBrowserConfigError).toBe('true')
    expect(document.body.textContent).toMatch(/mobile setup is incomplete/i)
    expect(document.body.textContent).not.toContain('missing')
  })
})
