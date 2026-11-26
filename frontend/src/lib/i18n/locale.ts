import { getLocale, isLocale, setLocale, type Locale } from '../paraglide/runtime.js'

export const localeStorageKey = 'capture:locale'

export function detectLocale(languages: readonly string[]): Locale {
  return languages.some((language) => language.toLowerCase().startsWith('zh')) ? 'zh-CN' : 'en'
}

export function deviceLocale(browser: Window = window): Locale {
  for (const storage of ['sessionStorage', 'localStorage'] as const) {
    try {
      const choice = browser[storage].getItem(localeStorageKey)
      if (isLocale(choice)) return choice
    } catch {
      // Storage can be blocked by the browser.
    }
  }
  return detectLocale(browser.navigator.languages ?? [])
}

export function saveLocale(locale: Locale, browser: Window = window): boolean {
  try {
    browser.localStorage.setItem(localeStorageKey, locale)
  } catch {
    try {
      browser.sessionStorage.setItem(localeStorageKey, locale)
      return true
    } catch {
      return false
    }
  }
  try {
    browser.sessionStorage.removeItem(localeStorageKey)
  } catch {
    // There is no tab-scoped choice when session storage is unavailable.
  }
  return true
}

// The SPA can resolve messages during module initialization, before Svelte mounts.
if (typeof window !== 'undefined') void setLocale(deviceLocale(), { reload: false })

export function setDocumentLanguage() {
  document.documentElement.lang = getLocale()
}
