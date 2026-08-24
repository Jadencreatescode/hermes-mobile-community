const CACHE_PREFIX = 'hermes-mobile-shell-'
const CACHE_NAME = `${CACHE_PREFIX}v2`
const SCOPE_URL = new URL('./', self.registration.scope).href
const PRECACHE = [
  SCOPE_URL,
  new URL('./manifest.webmanifest', self.registration.scope).href,
  new URL('./apple-touch-icon.png', self.registration.scope).href,
  new URL('./hermes-pwa-192.png', self.registration.scope).href,
  new URL('./hermes-pwa-512.png', self.registration.scope).href
]

self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE_NAME).then(cache => cache.addAll(PRECACHE)))
})

self.addEventListener('activate', event => {
  event.waitUntil(
    caches
      .keys()
      .then(keys => Promise.all(keys.filter(key => key.startsWith(CACHE_PREFIX) && key !== CACHE_NAME).map(key => caches.delete(key))))
      .then(() => self.clients.claim())
  )
})

self.addEventListener('message', event => {
  if (event.data?.type === 'SKIP_WAITING') self.skipWaiting()
})

self.addEventListener('fetch', event => {
  const request = event.request
  if (request.method !== 'GET') return

  const url = new URL(request.url)
  if (url.origin !== self.location.origin) return
  if (
    url.pathname.startsWith('/api/') ||
    url.pathname.startsWith('/auth/') ||
    url.pathname === '/login' ||
    /^\/nodes\/[^/]+\/(?:api|auth)(?:\/|$)/.test(url.pathname) ||
    /^\/nodes\/[^/]+\/login$/.test(url.pathname)
  ) return

  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then(response => {
          if (response.ok) {
            const copy = response.clone()
            event.waitUntil(caches.open(CACHE_NAME).then(cache => cache.put(SCOPE_URL, copy)))
          }
          return response
        })
        .catch(() => caches.match(SCOPE_URL))
    )
    return
  }

  event.respondWith(
    caches.match(request).then(cached => {
      if (cached) return cached
      return fetch(request).then(response => {
        if (!response.ok) return response
        const copy = response.clone()
        event.waitUntil(caches.open(CACHE_NAME).then(cache => cache.put(request, copy)))
        return response
      })
    })
  )
})
