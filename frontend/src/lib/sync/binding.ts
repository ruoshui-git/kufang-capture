import Dexie from 'dexie'
import { derived, get, writable } from 'svelte/store'
import { getCaptureDb } from '../db'
import { SETTING_KEYS, type Setting } from '../types'
import type { Session, SessionUser } from './api'

const accountIdKey = 'account_id'
const accountNameKey = 'account_name'
export const syncLeaseKey = 'sync_cycle_lease'
export const photoUploadRetryKey = 'photo_upload_storage_retry_at'
export const sessionChangeKey = 'capture:session-change'

export type AccountAccess =
  | { kind: 'unknown' | 'signed_out' | 'unavailable' }
  | { kind: 'ready'; user: SessionUser }
  | { kind: 'blocked'; name: string; user: SessionUser | null; canSwitch: boolean }

export const accountUnavailable = 'This account is temporarily unavailable. Try again later.'
export const accountSignIn = 'Your session has ended. Sign in to sync.'
export const accountMismatch = (name: string) =>
  `This device belongs to ${name}. Sign in as ${name}, or use another browser profile.`

export class AccountRequestError extends Error {}

export function accountHeaders(id: string, init?: HeadersInit) {
  const headers = new Headers(init)
  headers.set('X-Capture-Account', id)
  return headers
}

export function requestHeaders(method: string, headers?: HeadersInit) {
  const result = new Headers(headers)
  if (!['GET', 'HEAD', 'OPTIONS'].includes(method.toUpperCase())) result.set('X-Capture-Request', '1')
  return result
}

export async function responseCode(response: Response): Promise<string | undefined> {
  const body = (await response
    .clone()
    .json()
    .catch(() => null)) as { code?: string; detail?: string } | null
  return body?.code ?? body?.detail
}

export class AccountGate {
  private readonly state = writable<AccountAccess>({ kind: 'unknown' })
  readonly access = { subscribe: this.state.subscribe }
  private generation = 0
  private database?: ReturnType<typeof getCaptureDb>

  constructor(private readonly dbName?: string) {}

  private get db() {
    return (this.database ??= getCaptureDb(this.dbName))
  }

  get current() {
    return get(this.state)
  }

  get sessionGeneration() {
    return this.generation
  }

  reset(signedOut = false) {
    this.generation++
    this.state.set({ kind: signedOut ? 'signed_out' : 'unknown' })
  }

  private update(access: AccountAccess) {
    const old = this.current
    if (
      old.kind === access.kind &&
      (old.kind === 'ready' && access.kind === 'ready'
        ? old.user.id === access.user.id && old.user.name === access.user.name
        : old.kind === 'blocked' && access.kind === 'blocked'
          ? old.name === access.name && old.user?.id === access.user?.id && old.canSwitch === access.canSwitch
          : true)
    )
      return old
    if (access.kind === 'blocked') this.generation++
    this.state.set(access)
    return access
  }

  /** Check identity before using the database or server data belonging to an account. */
  async check(fetcher: typeof fetch, signal?: AbortSignal, allowSwitch = false): Promise<AccountAccess> {
    if (this.current.kind === 'blocked' && !allowSwitch) return this.current
    const generation = this.generation
    const response = await fetcher('/api/auth/session', {
      credentials: 'same-origin',
      cache: 'no-store',
      signal,
    })
    signal?.throwIfAborted()
    if (this.generation !== generation) throw new DOMException('The account changed.', 'AbortError')
    if (response.status === 503 && (await responseCode(response)) === 'account_unavailable') {
      this.unavailable()
      throw new AccountRequestError(accountUnavailable)
    }
    if (response.status === 401) return this.update({ kind: 'signed_out' })
    if (!response.ok) throw new Error(`Session request failed (${response.status}).`)
    const session: Session = await response.json()
    signal?.throwIfAborted()
    if (this.generation !== generation) throw new DOMException('The account changed.', 'AbortError')
    if (!session.authenticated) return this.update({ kind: 'signed_out' })
    if (!session.user?.id) throw new AccountRequestError('Could not verify the signed-in account.')
    const access = await this.bind(session.user, allowSwitch, signal, generation)
    signal?.throwIfAborted()
    if (this.generation !== generation) throw new DOMException('The account changed.', 'AbortError')
    return this.update(access)
  }

  private async bind(
    user: SessionUser,
    allowSwitch: boolean,
    signal: AbortSignal | undefined,
    generation: number,
  ): Promise<AccountAccess> {
    const db = this.db
    const [boundId, boundName] = await db.settings.bulkGet([accountIdKey, accountNameKey])
    if (boundId?.value === user.id && boundName?.value === user.name) return { kind: 'ready', user }
    return db.transaction('rw', [db.settings, db.collections, db.outbox], async () => {
      const [id, name] = await db.settings.bulkGet([accountIdKey, accountNameKey])
      const ensureCurrent = () => {
        signal?.throwIfAborted()
        if (this.generation !== generation) throw new DOMException('The account changed.', 'AbortError')
      }
      ensureCurrent()
      if (id?.value === user.id) {
        if (name?.value !== user.name) await db.settings.put({ key: accountNameKey, value: user.name })
        return { kind: 'ready', user }
      }
      const hasSyncedData =
        !!(await db.collections.filter((collection) => collection.storage_mode === 'synced').first()) ||
        (await db.outbox.count()) > 0
      ensureCurrent()
      if (id || (hasSyncedData && !user.is_owner)) {
        const blocked = {
          kind: 'blocked' as const,
          name: String(name?.value ?? 'Owner'),
          user,
          canSwitch: !hasSyncedData,
        }
        if (!allowSwitch || !blocked.canSwitch) return blocked
        const lease = (await db.settings.get(syncLeaseKey))?.value as { expiresAt: number } | undefined
        ensureCurrent()
        if (lease && lease.expiresAt > Date.now())
          throw new AccountRequestError('Sync is finishing. Try switching again in a moment.')
      }
      const settings: Setting[] = [
        { key: accountIdKey, value: user.id },
        { key: accountNameKey, value: user.name },
      ]
      // Preserve the existing owner's cursor on upgrade. A new account starts at its first change.
      if (id || !user.is_owner) {
        settings.push(
          { key: SETTING_KEYS.syncCursor, value: 0 },
          { key: SETTING_KEYS.lastStorageMode, value: user.is_owner ? 'local_only' : 'synced' },
        )
        await db.settings.bulkDelete([photoUploadRetryKey, SETTING_KEYS.syncSchema2Cursor])
      }
      await db.settings.bulkPut(settings)
      return { kind: 'ready', user }
    })
  }

  unavailable() {
    if (this.current.kind !== 'blocked') this.update({ kind: 'unavailable' })
  }

  block(id: string) {
    const current = this.current
    if (current.kind === 'ready' && current.user.id === id) {
      this.update({ kind: 'blocked', name: current.user.name, user: null, canSwitch: false })
    }
  }

  requireReady(access = this.current): SessionUser {
    if (access.kind === 'ready') return access.user
    if (access.kind === 'unavailable') throw new AccountRequestError(accountUnavailable)
    throw new AccountRequestError(access.kind === 'blocked' ? accountMismatch(access.name) : accountSignIn)
  }

  async request(fetcher: typeof fetch, url: string, init: RequestInit = {}, photoId?: string) {
    const access = await this.check(fetcher, init.signal ?? undefined)
    const user = this.requireReady(access)
    const generation = this.generation
    const send = () => {
      if (this.generation !== generation || this.requireReady().id !== user.id)
        throw new AccountRequestError('The account changed. Try again.')
      return fetcher(url, {
        ...init,
        credentials: 'same-origin',
        cache: 'no-store',
        headers: accountHeaders(user.id, requestHeaders(init.method ?? 'GET', init.headers)),
      })
    }

    const db = this.db
    const tables =
      photoId === undefined ? [db.settings] : [db.settings, db.photos, db.entries, db.collections]
    // Start the fetch under a read snapshot so edits cannot change the binding or make a photo Local Only first.
    const request = await db.transaction('r', tables, async () => {
      if ((await db.settings.get(accountIdKey))?.value !== user.id)
        throw new AccountRequestError('The account changed. Try again.')
      if (photoId !== undefined) {
        const photo = await db.photos.get(photoId)
        const entries = photo ? await db.entries.where('item_id').equals(photo.item_id).toArray() : []
        const collections = await db.collections.bulkGet(entries.map((entry) => entry.collection_id))
        if (
          !collections.some((collection) => collection?.storage_mode === 'synced') ||
          collections.some((collection) => collection?.storage_mode === 'local_only')
        )
          throw new AccountRequestError('The original is only available on this device.')
      }
      const response = Dexie.ignoreTransaction(async () => send())
      void response.catch(() => {})
      return { response }
    })
    const response = await request.response
    if (
      response.status === 409 &&
      ['account_mismatch', 'account_required'].includes((await responseCode(response)) ?? '')
    ) {
      this.block(user.id)
      throw new AccountRequestError(accountMismatch(user.name))
    }
    if (this.generation !== generation || this.requireReady().id !== user.id)
      throw new AccountRequestError('The account changed. Try again.')
    if (response.status === 503 && (await responseCode(response)) === 'account_unavailable') {
      this.unavailable()
      throw new AccountRequestError(accountUnavailable)
    }
    if (response.status === 401) {
      this.reset(true)
      throw new AccountRequestError(accountSignIn)
    }
    return response
  }
}

export const accountGate = new AccountGate()
export const accountAccess = accountGate.access
export const photoAccount = derived(accountAccess, (access) =>
  access.kind === 'ready' ? access.user.id : null,
)

export const fetchAccountPhoto = (id: string, kind: 'original' | 'thumbnail') =>
  accountGate.request(fetch, `/api/photos/${encodeURIComponent(id)}/${kind}`, {}, id)
