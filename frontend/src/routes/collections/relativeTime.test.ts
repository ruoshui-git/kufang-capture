import { describe, expect, it } from 'vitest'
import { relativeTime } from './relativeTime'

const now = new Date('2026-11-08T12:00:00.000Z').getTime()

describe('relativeTime', () => {
  it('uses sentence-case fragments for recent updates', () => {
    expect(relativeTime('2026-11-08T11:59:30.000Z', now)).toBe('just now')
    expect(relativeTime('2026-11-08T11:55:00.000Z', now)).toBe('5 min ago')
    expect(relativeTime('2026-11-07T12:00:00.000Z', now)).toBe('yesterday')
  })

  it('falls back to a date for older activity', () => {
    expect(relativeTime('2026-10-01T12:00:00.000Z', now)).toBe(
      new Date('2026-10-01T12:00:00.000Z').toLocaleDateString(),
    )
  })
})
