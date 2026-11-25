import { describe, expect, it } from 'vitest'
import { accountFromEvent, accountFromStatus } from './account'

describe('shared account state transitions', () => {
  it('keeps failed or pending checks unknown and reflects definitive session status', () => {
    expect(accountFromStatus({ authenticated: null })).toBeNull()
    expect(accountFromStatus({ authenticated: true })).toBe(true)
    expect(accountFromStatus({ authenticated: false })).toBe(false)
  })

  it('applies login and sign-out events immediately', () => {
    expect(accountFromEvent('capture:authenticated')).toBe(true)
    expect(accountFromEvent('capture:signed-out')).toBe(false)
  })
})
