import { describe, expect, it } from 'vitest'
import { addDecimals, isIncomplete } from './index'

describe('summary arithmetic', () => {
  it('adds decimals without floating point rounding', () => {
    expect(addDecimals('0.1', '0.2')).toBe('0.3')
    expect(addDecimals('5.00', '12')).toBe('17')
    expect(addDecimals('-1.25', '0.5')).toBe('-0.75')
  })
  it('treats blank quantities as incomplete while preserving zero', () => {
    expect(isIncomplete({ quantity: '', review_status: 'draft' }, true)).toBe(true)
    expect(isIncomplete({ quantity: '0', review_status: 'draft' }, true)).toBe(false)
  })
})
