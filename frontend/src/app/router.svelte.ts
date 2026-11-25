import { dismissOverlaysForNavigation, handleOverlayPop, hasPendingOverlayPop } from '$lib/ui/overlayHistory'

export type Route =
  | { name: 'collections' }
  | { name: 'starred' }
  | { name: 'entries'; collectionId: string }
  | { name: 'detail'; collectionId: string; entryId: string }
  | { name: 'settings' }
  | { name: 'diagnostics' }
  | { name: 'login' }
  | { name: 'join' }
  | { name: 'server' }
  | { name: 'not-found' }

function match(path: string): Route {
  const clean = path.replace(/\/$/, '') || '/'
  if (clean === '/') return { name: 'collections' }
  if (clean === '/starred') return { name: 'starred' }
  if (clean === '/settings') return { name: 'settings' }
  if (clean === '/diagnostics') return { name: 'diagnostics' }
  if (clean === '/join') return { name: 'join' }
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
let deferredNavigation: { path: string; replace: boolean } | undefined

function update() {
  router.route = match(window.location.pathname)
}

function onPopState() {
  const consumed = handleOverlayPop()
  update()
  if (consumed && deferredNavigation) {
    const pending = deferredNavigation
    deferredNavigation = undefined
    requestNavigation(pending.path, pending.replace)
  }
}

if (typeof window !== 'undefined') {
  window.addEventListener('popstate', onPopState)
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
    // Downloads (e.g. the export ZIP's blob: link, whose origin matches ours) are not navigation.
    if (anchor.hasAttribute('download') || !/^https?:$/.test(anchor.protocol)) return
    event.preventDefault()
    navigate(anchor.pathname + anchor.search + anchor.hash)
  })
}

export function navigate(path: string, options: { replace?: boolean } = {}) {
  requestNavigation(path, options.replace ?? false)
}

function requestNavigation(path: string, replace: boolean) {
  if (hasPendingOverlayPop()) {
    deferredNavigation = { path, replace }
    return
  }
  if (dismissOverlaysForNavigation()) {
    deferredNavigation = { path, replace }
    return
  }
  applyNavigation(path, replace)
}

function applyNavigation(path: string, replace: boolean) {
  if (replace) history.replaceState(null, '', path)
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
