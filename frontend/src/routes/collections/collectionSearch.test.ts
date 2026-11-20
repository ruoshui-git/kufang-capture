import { describe, expect, it } from 'vitest'
import { collectionMatches } from './collectionSearch'

const summary = (name: string, folder?: string) => ({ collection: { name, folder } }) as never

describe('collectionMatches', () => {
  it('matches blank queries', () => {
    expect(collectionMatches(summary('Temple A04'), '')).toBe(true)
    expect(collectionMatches(summary('Temple A04'), '   ')).toBe(true)
  })

  it('ignores case and diacritics', () => {
    expect(collectionMatches(summary('Café Supplies'), 'cafe')).toBe(true)
  })

  it('matches every token across the name and folder', () => {
    expect(collectionMatches(summary('A04', 'Temple 2'), 'temple a04')).toBe(true)
    expect(collectionMatches(summary('Temple A04', 'North'), 'temple north')).toBe(true)
  })

  it('rejects a query when any token is missing', () => {
    expect(collectionMatches(summary('Temple A04', 'North'), 'temple missing')).toBe(false)
  })

  it('matches CJK substrings', () => {
    expect(collectionMatches(summary('佛堂用品'), '堂用')).toBe(true)
  })

  it('handles an undefined folder', () => {
    expect(collectionMatches(summary('North Room'), 'north room')).toBe(true)
    expect(collectionMatches(summary('North Room'), 'storage')).toBe(false)
  })
})
