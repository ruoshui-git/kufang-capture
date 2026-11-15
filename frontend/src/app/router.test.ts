import { describe, expect, it } from 'vitest'
import { matchRoute, navigate, router } from './router.svelte'

describe('router matching', () => {
  it('matches collection list, entries, detail, and utility routes', () => {
    expect(matchRoute('/')).toEqual({ name: 'collections' })
    expect(matchRoute('/starred')).toEqual({ name: 'starred' })
    expect(matchRoute('/c/room-1')).toEqual({ name: 'entries', collectionId: 'room-1' })
    expect(matchRoute('/c/room-1/e/item-2')).toEqual({
      name: 'detail',
      collectionId: 'room-1',
      entryId: 'item-2',
    })
    expect(matchRoute('/settings')).toEqual({ name: 'settings' })
    expect(matchRoute('/diagnostics')).toEqual({ name: 'diagnostics' })
  })
  it('decodes route parameters and returns a 404 route for unknown paths', () => {
    expect(matchRoute('/c/room%20one')).toEqual({ name: 'entries', collectionId: 'room one' })
    expect(matchRoute('/unknown')).toEqual({ name: 'not-found' })
  })
})

describe('router link interception', () => {
  function click(anchor: HTMLAnchorElement): boolean {
    document.body.append(anchor)
    const event = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 })
    anchor.dispatchEvent(event)
    anchor.remove()
    return event.defaultPrevented
  }

  it('routes same-origin app links', () => {
    const anchor = document.createElement('a')
    anchor.href = '/settings'
    expect(click(anchor)).toBe(true)
    expect(router.route).toEqual({ name: 'settings' })
    navigate('/')
  })

  it('leaves download links alone, including same-origin blob: export links', () => {
    const before = window.location.pathname
    const blobLink = document.createElement('a')
    blobLink.href = `blob:${location.origin}/0f0c-export`
    blobLink.download = 'kufang-capture-all.zip'
    expect(click(blobLink)).toBe(false)
    const fileLink = document.createElement('a')
    fileLink.href = '/api/exports/all.zip'
    fileLink.setAttribute('download', '')
    expect(click(fileLink)).toBe(false)
    expect(window.location.pathname).toBe(before)
  })
})
