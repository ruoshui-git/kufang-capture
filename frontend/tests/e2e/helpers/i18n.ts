import { expect, type Locator, type Page } from '@playwright/test'
import { localeStorageKey } from '../../../src/lib/i18n/locale'

export async function useChinese(page: Page) {
  await page.addInitScript((key) => {
    try {
      if (localStorage.getItem(key) === null) localStorage.setItem(key, 'zh-CN')
    } catch {
      // about:blank and sandboxed frames can deny storage.
    }
  }, localeStorageKey)
}

const defaultAllow = [
  'Kufang',
  'Capture',
  'PWA',
  'QR',
  'ID',
  'ZIP',
  'HTTP',
  'Safari',
  'Chrome',
  'English',
  /#[0-9]{4,}/,
  /\b(?:B|KB|MB|GB|TB)\b/,
]

/** Supply test-owned names, notes or units in allow. Root defaults to the whole visible page. */
export async function expectNoEnglish(
  page: Page,
  { allow = [], root = page.locator('body') }: { allow?: (string | RegExp)[]; root?: Locator } = {},
) {
  const visible = await root.evaluate((element) => {
    const items: Array<{ from: string; text: string }> = []
    const include = (node: Element) =>
      !node.matches('script,style,template,noscript') &&
      node.checkVisibility({ opacityProperty: true, visibilityProperty: true })
    const record = (node: Element, field: string, text: string | null) => {
      if (text?.trim()) items.push({ from: `<${node.tagName.toLowerCase()}> ${field}`, text: text.trim() })
    }

    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT)
    const range = document.createRange()
    for (let text = walker.nextNode(); text; text = walker.nextNode()) {
      const parent = text.parentElement
      if (!parent || !include(parent)) continue
      range.selectNodeContents(text)
      if (range.getClientRects().length) record(parent, 'text', text.textContent)
    }
    for (const node of [element, ...element.querySelectorAll('*')].filter(include)) {
      for (const attr of ['aria-label', 'aria-description', 'title', 'placeholder', 'alt']) {
        record(node, attr, node.getAttribute(attr))
      }
      if (
        node instanceof HTMLButtonElement ||
        node.matches('input[type=button],input[type=submit],input[type=reset]')
      )
        record(node, 'value', (node as HTMLButtonElement | HTMLInputElement).value)
      if (node instanceof HTMLSelectElement)
        for (const selected of node.selectedOptions) record(node, 'selected option', selected.label)
    }
    return items
  })

  const allowed = [...defaultAllow, ...allow].map((item) =>
    typeof item === 'string'
      ? new RegExp(`(?<![A-Za-z])${item.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![A-Za-z])`, 'g')
      : new RegExp(item.source, item.flags.includes('g') ? item.flags : `${item.flags}g`),
  )
  const findings = visible.flatMap(({ from, text }) => {
    const remaining = allowed.reduce((value, pattern) => value.replace(pattern, ' '), text)
    const words = remaining.match(/[A-Za-z]{2,}/g)
    return words ? [`${from}: ${words.join(', ')} in ${JSON.stringify(text)}`] : []
  })
  expect([...new Set(findings)], 'Unexpected Latin words in the visible UI').toEqual([])
}
