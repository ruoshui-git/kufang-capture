import { afterEach, describe, expect, it, vi } from 'vitest'
import { setLocale } from '../paraglide/runtime.js'
import { detectLocale, deviceLocale, localeStorageKey, saveLocale, setDocumentLanguage } from './locale'

afterEach(() => {
  localStorage.clear()
  sessionStorage.clear()
  void setLocale('en', { reload: false })
  setDocumentLanguage()
  vi.unstubAllGlobals()
})

describe('device language', () => {
  it.each(['zh', 'zh-CN', 'zh-TW', 'zh-HK', 'zh-Hans-SG'])('selects Simplified Chinese for %s', (tag) => {
    expect(detectLocale(['en-US', tag])).toBe('zh-CN')
  })

  it('falls back to English for other languages and empty preferences', () => {
    expect(detectLocale([])).toBe('en')
    expect(detectLocale(['en-CA', 'fr-CA'])).toBe('en')
  })

  it('preserves a manual override and ignores an unsupported stored choice', () => {
    vi.spyOn(window.navigator, 'languages', 'get').mockReturnValue(['en-US'])
    expect(saveLocale('zh-CN')).toBe(true)
    expect(localStorage.getItem(localeStorageKey)).toBe('zh-CN')
    expect(deviceLocale()).toBe('zh-CN')
    localStorage.setItem(localeStorageKey, 'zh-TW')
    expect(deviceLocale()).toBe('en')
  })

  it('uses session storage when persistent writes fail and recovers a later persistent choice', () => {
    localStorage.setItem(localeStorageKey, 'en')
    const store = Storage.prototype.setItem
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (
      this: Storage,
      key,
      value,
    ) {
      if (this === localStorage) throw new DOMException('quota', 'QuotaExceededError')
      store.call(this, key, value)
    })
    expect(saveLocale('zh-CN')).toBe(true)
    expect(deviceLocale()).toBe('zh-CN')
    setItem.mockRestore()
    expect(saveLocale('en')).toBe(true)
    expect(sessionStorage.getItem(localeStorageKey)).toBeNull()
    expect(deviceLocale()).toBe('en')
  })

  it('uses browser preferences when both storage APIs are denied', () => {
    const deny = () => {
      throw new DOMException('blocked', 'SecurityError')
    }
    const local = vi.spyOn(window, 'localStorage', 'get').mockImplementation(deny)
    const session = vi.spyOn(window, 'sessionStorage', 'get').mockImplementation(deny)
    vi.spyOn(window.navigator, 'languages', 'get').mockReturnValue(['zh-HK'])
    expect(deviceLocale()).toBe('zh-CN')
    expect(saveLocale('en')).toBe(false)
    local.mockRestore()
    session.mockRestore()
  })

  it('sets the root language to the active locale', () => {
    void setLocale('zh-CN', { reload: false })
    setDocumentLanguage()
    expect(document.documentElement.lang).toBe('zh-CN')
    void setLocale('en', { reload: false })
    setDocumentLanguage()
    expect(document.documentElement.lang).toBe('en')
  })
})
