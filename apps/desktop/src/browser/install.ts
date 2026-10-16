import { installBrowserBridge } from './bridge'

function showMobileSetupError(): void {
  document.documentElement.dataset.hermesBrowserConfigError = 'true'
  const root = document.getElementById('root') ?? document.body
  const main = document.createElement('main')
  const title = document.createElement('h1')
  const detail = document.createElement('p')

  main.setAttribute('role', 'alert')
  main.style.cssText = 'box-sizing:border-box;max-width:42rem;margin:12vh auto;padding:2rem;font:16px/1.5 system-ui,sans-serif;color:#f5f5f5;background:#171717;border:1px solid #444;border-radius:16px'
  title.textContent = 'Hermes mobile setup is incomplete'
  detail.textContent = 'This private mobile address is not connected to a configured Hermes backend. Run the installer again on the Hermes computer.'
  main.append(title, detail)
  root.replaceChildren(main)
}

const hadDesktopBridge = Boolean(window.hermesDesktop)

try {
  await installBrowserBridge()
} catch (error) {
  showMobileSetupError()
  throw error
}

if (!hadDesktopBridge) {
  void Promise.all([import('./pwa'), import('@/store/notifications')])
    .then(([pwa, notifications]) => {
      pwa.bindMobileUpdatePrompt({ notify: notifications.notify })

      return pwa.registerMobileServiceWorker()
    })
    .catch(() => undefined)
}
