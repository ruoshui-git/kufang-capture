import { writable } from 'svelte/store'
import type { SyncStatus } from './api'

/** null means the account state is unknown, including when the session check is offline. */
export const accountAuthenticated = writable<boolean | null>(null)

export function accountFromStatus(status: Pick<SyncStatus, 'authenticated'>): boolean | null {
  return status.authenticated
}

export function accountFromEvent(type: 'capture:authenticated' | 'capture:signed-out'): boolean {
  return type === 'capture:authenticated'
}

let started = false

/** Start one shared status and session observer for the lifetime of the app. */
export function startAccountState() {
  if (started || typeof window === 'undefined') return
  started = true
  const onAuthenticated = () => {
    accountAuthenticated.set(accountFromEvent('capture:authenticated'))
  }
  const onSignedOut = () => {
    accountAuthenticated.set(accountFromEvent('capture:signed-out'))
  }
  window.addEventListener('capture:authenticated', onAuthenticated)
  window.addEventListener('capture:signed-out', onSignedOut)
  void import('$lib/sync').then(({ syncEngine }) => {
    syncEngine.status.subscribe((status) => {
      accountAuthenticated.set(accountFromStatus(status))
    })
  })
}
