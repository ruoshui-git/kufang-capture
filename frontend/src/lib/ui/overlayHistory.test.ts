import { afterEach, describe, expect, it, vi } from 'vitest'
import { handleOverlayPop, openOverlay } from './overlayHistory'

describe('overlay history', () => {
  afterEach(() => {
    history.replaceState(null, '', '/')
  })

  it('consumes Back for the top overlay and replaces UI dismissals without a delayed pop', () => {
    vi.spyOn(history, 'back').mockImplementation(() => {})
    const closeParent = vi.fn()
    const closeChild = vi.fn()
    const unregisterParent = openOverlay(closeParent)
    const unregisterChild = openOverlay(closeChild)
    expect(history.length).toBeGreaterThan(1)
    unregisterChild()
    expect(history.back).toHaveBeenCalledOnce()
    expect(handleOverlayPop()).toBe(true)
    expect(closeChild).not.toHaveBeenCalled()
    unregisterParent()
    expect(handleOverlayPop()).toBe(false)
  })
})
