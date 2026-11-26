import { describe, expect, it } from 'vitest'

type Variant = { declarations?: string[]; match: Record<string, string> }
type Message = string | Variant[]

const sources = import.meta.glob<string>('../../../messages/*/*.json', {
  query: '?raw',
  import: 'default',
  eager: true,
})

// Give every intentional identical value a documented reason.
const identicalValues = new Map<string, string>()

function catalog(area: string, locale: string): Record<string, Message> {
  const json = sources[`../../../messages/${area}/${locale}.json`]
  expect(json, `${area}/${locale}.json`).toBeDefined()
  const { $schema: _schema, ...messages } = JSON.parse(json!)
  return messages
}

function texts(message: Message): string[] {
  return typeof message === 'string' ? [message] : message.flatMap((variant) => Object.values(variant.match))
}

function placeholders(message: Message): Set<string> {
  return new Set(
    texts(message).flatMap((text) => [...text.matchAll(/(?<!\\)\{([\w$]+)\}/g)].map((match) => match[1]!)),
  )
}

function inputs(message: Message): Set<string> {
  return new Set(
    typeof message === 'string'
      ? placeholders(message)
      : message
          .flatMap((variant) =>
            (variant.declarations ?? []).flatMap((declaration) => {
              const input = /^input\s+([\w$]+)/.exec(declaration)
              return input ? [input[1]!] : []
            }),
          )
          .concat([...placeholders(message)]),
  )
}

describe('message parity', () => {
  it.each(['core', 'shell', 'entry', 'account'])('checks both locale catalogs for %s', (area) => {
    const english = catalog(area, 'en')
    const chinese = catalog(area, 'zh-CN')
    expect(Object.keys(chinese).sort()).toEqual(Object.keys(english).sort())
    for (const [name, base] of Object.entries(english)) {
      expect(name).toMatch(new RegExp(`^${area}_`))
      const translation = chinese[name]!
      const englishTexts = texts(base)
      const chineseTexts = texts(translation)
      expect(chineseTexts, name).not.toHaveLength(0)
      for (const text of chineseTexts) {
        expect(text.trim(), name).not.toBe('')
        if (!identicalValues.has(name)) expect(englishTexts, name).not.toContain(text)
      }
      expect(placeholders(translation), name).toEqual(placeholders(base))
      expect(inputs(translation), name).toEqual(inputs(base))
    }
  })
})
