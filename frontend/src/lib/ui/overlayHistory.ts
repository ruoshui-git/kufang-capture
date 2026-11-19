const marker = '__kufangOverlay'
type Overlay = { id: number; close: () => void }
let nextId = 1
const overlays: Overlay[] = []
let pendingOverlayPops = 0

function stateWith(id: number | null) {
  const state = history.state && typeof history.state === 'object' ? history.state : {}
  const next = { ...state }
  if (id === null) delete next[marker]
  else next[marker] = id
  return next
}

export function openOverlay(close: () => void): () => void {
  const id = nextId++
  overlays.push({ id, close })
  history.pushState(stateWith(id), '', location.href)
  let active = true
  return () => {
    if (!active) return
    active = false
    const index = overlays.findIndex((overlay) => overlay.id === id)
    if (index < 0) return
    const wasTop = index === overlays.length - 1
    overlays.splice(index, 1)
    if (wasTop && history.state?.[marker] === id) {
      pendingOverlayPops += 1
      history.back()
    }
  }
}

/** Called by the router for popstate. Returns true when an overlay consumed Back. */
export function handleOverlayPop(): boolean {
  if (pendingOverlayPops > 0) {
    pendingOverlayPops -= 1
    return true
  }
  const overlay = overlays.pop()
  if (!overlay) return false
  overlay.close()
  return true
}

export function hasPendingOverlayPop(): boolean {
  return pendingOverlayPops > 0
}

/** Remove every overlay entry before route navigation and close their UI. */
export function dismissOverlaysForNavigation(): boolean {
  if (!overlays.length) return false
  const count = overlays.length
  const closing = overlays.splice(0, count)
  pendingOverlayPops += count
  for (const overlay of closing.reverse()) overlay.close()
  history.go(-count)
  return true
}
