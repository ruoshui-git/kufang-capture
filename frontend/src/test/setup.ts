import 'fake-indexeddb/auto'
import '@testing-library/jest-dom/vitest'
import '$lib/i18n/locale'
import { setLocale } from '$lib/paraglide/runtime.js'

void setLocale('en', { reload: false })

// jsdom lacks HTMLDialogElement modal APIs.
if (typeof HTMLDialogElement !== 'undefined' && !HTMLDialogElement.prototype.showModal) {
  HTMLDialogElement.prototype.showModal = function (this: HTMLDialogElement) {
    this.setAttribute('open', '')
  }
  HTMLDialogElement.prototype.close = function (this: HTMLDialogElement, returnValue?: string) {
    this.removeAttribute('open')
    if (returnValue !== undefined) this.returnValue = returnValue
    this.dispatchEvent(new Event('close'))
  }
}
