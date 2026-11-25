import { describe, expect, it } from 'vitest'
import { isInAppBrowser, joinCodeFromHash, normalizeJoinCode } from './joinCode'

describe('helper join codes', () => {
  it('handles case, spacing, dashes and common look-alikes', () => {
    expect(normalizeJoinCode(' oIlb – cd e\tF ')).toBe('011B-CDEF')
    expect(joinCodeFromHash('#oIlb%20%E2%80%93cdEf')).toBe('011B-CDEF')
  })

  it('rejects malformed or non-ASCII input', () => {
    for (const code of ['', 'U234-5ABC', '1234-5ÄBC', '1234-56789', '1234-567', '1'.repeat(129)])
      expect(normalizeJoinCode(code)).toBe('')
    expect(joinCodeFromHash('#%zz')).toBe('')
  })

  it.each(['Mozilla MicroMessenger/9', 'Mozilla QQ/9', 'Mozilla AlipayClient/10'])(
    'detects web views that should open the code in a browser: %s',
    (agent) => expect(isInAppBrowser(agent)).toBe(true),
  )

  it.each([
    'iPhone AppleWebKit Version/17 Safari/604',
    'Android Chrome/124 Mobile Safari/537',
    'MQQBrowser/1',
  ])('allows normal browsers: %s', (agent) => expect(isInAppBrowser(agent)).toBe(false))
})
