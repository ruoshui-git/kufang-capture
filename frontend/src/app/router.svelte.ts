export type Route =
  | { name: 'collections' }
  | { name: 'entries'; collectionId: string }
  | { name: 'detail'; collectionId: string; entryId: string }
  | { name: 'settings' }
  | { name: 'diagnostics' }
  | { name: 'login' }
  | { name: 'server' }
  | { name: 'not-found' }

function match(path: string): Route {
  const clean = path.replace(/\/$/, '') || '/'
  if (clean === '/') return { name: 'collections' }
  if (clean === '/settings') return { name: 'settings' }
  if (clean === '/diagnostics') return { name: 'diagnostics' }
  if (clean === '/login') return { name: 'login' }
  if (clean === '/server') return { name: 'server' }
  const detail = clean.match(/^\/c\/([^/]+)\/e\/([^/]+)$/)
  if (detail)
    return {
      name: 'detail',
      collectionId: decodeURIComponent(detail[1]!),
      entryId: decodeURIComponent(detail[2]!),
    }
  const entries = clean.match(/^\/c\/([^/]+)$/)
  if (entries) return { name: 'entries', collectionId: decodeURIComponent(entries[1]!) }
  return { name: 'not-found' }
}

const media =
  typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    ? window.matchMedia('(min-width: 900px)')
    : undefined

export const router = $state({
  route: match(typeof window !== 'undefined' ? window.location.pathname : '/'),
  isDesktop: media?.matches ?? false,
})
const scrollPositions = new Map<string, number>()

function update() {
  router.route = match(window.location.pathname)
}

if (typeof window !== 'undefined') {
  window.addEventListener('popstate', update)
  media?.addEventListener('change', (event) => (router.isDesktop = event.matches))
  document.addEventListener('click', (event) => {
    if (
      event.defaultPrevented ||
      event.button !== 0 ||
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey ||
      event.altKey
    )
      return
    const target = event.target
    if (!(target instanceof Element)) return
    const anchor = target.closest('a[href]')
    if (!(anchor instanceof HTMLAnchorElement) || anchor.target || anchor.origin !== location.origin) return
    event.preventDefault()
    navigate(anchor.pathname + anchor.search + anchor.hash)
  })
}

export function navigate(path: string, options: { replace?: boolean } = {}) {
  if (options.replace) history.replaceState(null, '', path)
  else history.pushState(null, '', path)
  update()
  window.scrollTo({ top: 0 })
}

export function saveScroll(key: string) {
  scrollPositions.set(key, window.scrollY)
}

export function restoreScroll(key: string) {
  window.scrollTo({ top: scrollPositions.get(key) ?? 0 })
}

export function matchRoute(path: string): Route {
  return match(path)
}
