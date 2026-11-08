import { describe, expect, it } from 'vitest'
import { entryDisplayTitle, formatSequence } from './types'

describe('sequence formatting', () => {
  it('pads to four digits and keeps larger numbers intact', () => {
    expect(formatSequence(1)).toBe('#0001')
    expect(formatSequence(42)).toBe('#0042')
    expect(formatSequence(12345)).toBe('#12345')
  })
  it('falls back to the numbered title when no custom title is set', () => {
    expect(entryDisplayTitle({ title: '  ', sequence_number: 3 })).toBe('Entry #0003')
    expect(entryDisplayTitle({ title: 'Candles', sequence_number: 3 })).toBe('Candles')
  })
})
