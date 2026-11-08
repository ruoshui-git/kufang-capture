import { describe, expect, it } from 'vitest'
import { matchRoute } from './router.svelte'

describe('router matching', () => {
  it('matches collection list, entries, detail, and utility routes', () => {
    expect(matchRoute('/')).toEqual({ name: 'collections' })
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
