import { describe, expect, it } from 'vitest'
import { parseShareLocation, sharePath } from './location'

const token = 'abc-_'.padEnd(43, '0')

describe('share fragments', () => {
  it('accepts only a validated token, with an optional positive sequence', () => {
    const root = new URL(sharePath(token), 'https://example.test')
    expect(root.pathname).toBe('/share')
    expect(root.search).toBe('')
    expect(parseShareLocation(root.hash)).toEqual({ token, sequence: null })
    expect(parseShareLocation(`#${token}/e/42`)).toEqual({ token, sequence: 42 })
  })

  it.each([
    '',
    token,
    '#',
    '#short',
    `#${token}X`,
    `#${token}\n`,
    `#${token}/e/42\n`,
    `#${token}/e`,
    `#${token}/e/-1`,
    `#${token}/e/0`,
    `#${token}/e/1e3`,
    `#${token}/e/9007199254740992`,
    `#${token}/E/42`,
    `#${token}/e/42/`,
    `#${token}?view=42`,
  ])('rejects %s', (fragment) => {
    expect(parseShareLocation(fragment)).toBeNull()
  })
})
