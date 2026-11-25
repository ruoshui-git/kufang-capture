import { liveQuery } from 'dexie'
import { createId } from '../ids'
import {
  compareQueued,
  deletionOperation,
  getCaptureDb,
  isUnsent,
  newMutationId,
  queueMutation,
  readPhotoBlob,
  repairMissingCreate,
  repairSyncQueue,
  syncedItemIds,
  type PhotoWithUploadRetry,
} from '../db'
import {
  SETTING_KEYS,
  type Collection,
  type Entry,
  type Id,
  type Item,
  type OutboxItem,
  type Photo,
} from '../types'
import type { Watchable } from '../repo'
import type { AuthClient, ServerClient, SyncConflict, SyncEngine, SyncStatus } from './api'

type FetchLike = typeof fetch
type ServerRecord = Record<string, unknown> & { id: Id; revision?: number; server_revision?: number }
type BatchResult = {
  id: Id
  status: 'applied' | 'duplicate' | 'conflict' | 'rejected'
  server_revision: number | null
  record?: ServerRecord
  code?: string
  message?: string
  conflicting_fields?: string[]
  duplicate?: boolean
}

export interface SyncEngineOptions {
  repoDbName?: string
  fetch?: FetchLike
  now?: () => Date
  intervalMs?: number
}

function userError(error: unknown): string {
  if (error instanceof TypeError) return "Couldn't reach the server. Changes will retry when you're online."
  return error instanceof Error ? error.message : 'Sync failed. Please try again.'
}

function requestHeaders(method: string, headers?: HeadersInit): Headers {
  const result = new Headers(headers)
  if (!['GET', 'HEAD', 'OPTIONS'].includes(method.toUpperCase())) result.set('X-Capture-Request', '1')
  return result
}

function makeClients(fetcher: FetchLike): { authClient: AuthClient; serverClient: ServerClient } {
  const request = async (url: string, init: RequestInit = {}) => {
    const method = init.method ?? 'GET'
    const response = await fetcher(url, {
      ...init,
      method,
      headers: requestHeaders(method, init.headers),
      credentials: 'same-origin',
    })
    if (!response.ok) {
      if (response.status === 401) throw new Error('Your session has ended. Sign in to sync.')
      let message = `Request failed (${response.status}).`
      try {
        const data = (await response.json()) as { message?: string }
        if (data.message) message = data.message
      } catch {
        // Keep the plain fallback for non-JSON errors.
      }
      throw Object.assign(new Error(message), { status: response.status })
    }
    return response
  }
  return {
    authClient: {
      session: async () => (await request('/api/auth/session')).json(),
      login: async (password) => {
        // Login has its own error copy: a 401 here means a wrong password, not an ended session.
        let response: Response
        try {
          response = await fetcher('/api/auth/login', {
            method: 'POST',
            headers: requestHeaders('POST', { 'Content-Type': 'application/json' }),
            credentials: 'same-origin',
            body: JSON.stringify({ password }),
          })
        } catch {
          throw new Error("Couldn't reach the server. Check your connection and try again.")
        }
        if (response.status === 401) throw new Error('Password is incorrect.')
        if (response.status === 429) {
          const wait = Number(response.headers.get('Retry-After') ?? '60')
          const minutes = Math.max(1, Math.ceil(wait / 60))
          throw new Error(
            `Too many attempts. Try again in ${minutes} ${minutes === 1 ? 'minute' : 'minutes'}.`,
          )
        }
        if (!response.ok) throw new Error(`Sign-in failed (${response.status}). Try again.`)
        if (typeof window !== 'undefined') window.dispatchEvent(new Event('capture:authenticated'))
      },
      logout: async () => {
        await request('/api/auth/logout', { method: 'POST' })
        if (typeof window !== 'undefined') window.dispatchEvent(new Event('capture:signed-out'))
      },
    },
    serverClient: {
      listCollections: async () => (await request('/api/collections')).json(),
      exportUrl: (scope, opts = {}) =>
        `${scope === 'all' ? '/api/exports/all.zip' : `/api/exports/collections/${encodeURIComponent(scope.collectionId)}.zip`}?include_trash=${opts.includeTrash ? '1' : '0'}`,
      removeServerCopy: async (collectionId, confirmName) => {
        await request(`/api/collections/${encodeURIComponent(collectionId)}/server-copy`, {
          method: 'DELETE',
          headers: { 'X-Confirm-Name': confirmName },
        })
      },
    },
  }
}

/** Exported for tests; the app uses the default clients below. */
export const createClients = makeClients
export const { authClient, serverClient } = makeClients((input, init) => fetch(input, init))

/** The engine plus the backoff-respecting cycle that timers use (exposed for tests). */
export type SyncEngineWithSchedule = SyncEngine & { runScheduledCycle(): Promise<void> }

export function createSyncEngine(options: SyncEngineOptions = {}): SyncEngineWithSchedule {
  const db = getCaptureDb(options.repoDbName)
  const fetcher = options.fetch ?? fetch
  const now = options.now ?? (() => new Date())
  const timestamp = () => now().toISOString()
  const controller = { current: null as AbortController | null }
  let phase: SyncStatus['phase'] = 'idle'
  let authenticated: boolean | null = null
  let lastSuccess: string | null = null
  let lastError: string | null = null
  let running: Promise<void> | null = null
  let rerun = false
  let uploadRetryAt = 0
  let needsRepair = false
  let authBlocked = false
  let started = false
  let timer: ReturnType<typeof setInterval> | undefined
  let debounce: ReturnType<typeof setTimeout> | undefined
  let unsubscribeOutbox: (() => void) | undefined
  const statusListeners = new Set<(value: SyncStatus) => void>()
  const conflictListeners = new Set<(value: SyncConflict[]) => void>()
  let statusValue: SyncStatus = emptyStatus()

  function emptyStatus(): SyncStatus {
    return {
      phase,
      online: typeof navigator === 'undefined' || navigator.onLine,
      authenticated,
      last_success_at: lastSuccess,
      last_error: lastError,
      pending_mutations: 0,
      pending_uploads: 0,
      pending_upload_bytes: 0,
      conflicts: 0,
      per_collection: {},
    }
  }

  const status: Watchable<SyncStatus> = {
    subscribe(next) {
      statusListeners.add(next)
      next(statusValue)
      return () => statusListeners.delete(next)
    },
  }
  const conflicts: Watchable<SyncConflict[]> = {
    subscribe(next) {
      conflictListeners.add(next)
      const subscription = liveQuery(() => db.conflicts.orderBy('created_at').toArray()).subscribe(next)
      return () => {
        conflictListeners.delete(next)
        subscription.unsubscribe()
      }
    },
  }

  async function refreshStatus() {
    const [collections, items, photos, conflictRows] = await Promise.all([
      db.collections.toArray(),
      db.outbox.toArray(),
      db.photos.toArray(),
      db.conflicts.toArray(),
    ])
    const synced = collections.filter((item) => item.storage_mode === 'synced')
    const per: SyncStatus['per_collection'] = {}
    for (const collection of synced) {
      const ownEntries = await db.entries.where('collection_id').equals(collection.id).toArray()
      const ownItems = new Set(ownEntries.map((entry) => entry.item_id))
      const ownPhotoIds = new Set(
        photos.filter((photo) => ownItems.has(photo.item_id)).map((photo) => photo.id),
      )
      const mutations = items.filter(
        (item) =>
          item.collection_id === collection.id ||
          (item.entity === 'item' && ownItems.has(item.entity_id)) ||
          (item.entity === 'photo' && ownPhotoIds.has(item.entity_id)),
      )
      const pendingPhotos = photos.filter(
        (photo) =>
          ownItems.has(photo.item_id) && ['pending', 'uploading', 'error'].includes(photo.upload_state),
      )
      const errors =
        mutations.filter((item) => item.last_error).length +
        pendingPhotos.filter((p) => p.upload_state === 'error').length
      per[collection.id] = {
        collection_id: collection.id,
        pending_mutations: mutations.length,
        pending_uploads: pendingPhotos.length,
        pending_upload_bytes: pendingPhotos.reduce((sum, photo) => sum + photo.byte_size, 0),
        errors,
        conflicts: conflictRows.filter((item) => item.collection_id === collection.id).length,
        last_synced_at: null,
      }
    }
    const pendingMutations = Object.values(per).reduce((sum, item) => sum + item.pending_mutations, 0)
    const pendingPhotos = Object.values(per).reduce((sum, item) => sum + item.pending_uploads, 0)
    statusValue = {
      ...emptyStatus(),
      last_error:
        lastError ??
        photos.find((photo) => photo.upload_state === 'error' && photo.upload_error)?.upload_error ??
        null,
      pending_mutations: pendingMutations,
      pending_uploads: pendingPhotos,
      pending_upload_bytes: Object.values(per).reduce((sum, item) => sum + item.pending_upload_bytes, 0),
      conflicts: conflictRows.filter((row) =>
        synced.some((collection) => collection.id === row.collection_id),
      ).length,
      per_collection: per,
    }
    for (const listener of statusListeners) listener(statusValue)
  }

  const statusSubscription = liveQuery(async () => {
    await refreshStatus()
    return true
  }).subscribe()

  const storageLow = 'Server storage is low'
  const storageRetryKey = 'photo_upload_storage_retry_at'
  const storedUploadRetryAt = async () => Number((await db.settings.get(storageRetryKey))?.value ?? 0)

  async function haltOnStatus(code: number) {
    if (code === 401) {
      authBlocked = true
      authenticated = false
      phase = 'signed_out'
    } else if (code === 507) {
      uploadRetryAt = now().getTime() + 300_000
      lastError = storageLow
      await db.settings.put({ key: storageRetryKey, value: uploadRetryAt })
    } else return false
    return true
  }

  async function push(signal: AbortSignal) {
    const deviceId = await db.settings.get(SETTING_KEYS.deviceId)
    // Select and claim in one transaction so an edit cannot coalesce into the request
    // while it is being prepared, and a storage-mode change cannot leave a stale selection.
    const selected = await db.transaction(
      'rw',
      [db.collections, db.entries, db.photos, db.outbox],
      async () => {
        const rows = await db.outbox.toArray()
        if (signal.aborted || !rows.length) return []
        const collections = await db.collections.toArray()
        const allowed = new Set(collections.filter((c) => c.storage_mode === 'synced').map((c) => c.id))
        const syncedItems = await syncedItemIds(db, collections)
        const priority = { collection: 0, item: 1, entry: 2, photo: 3 }
        rows.sort((a, b) => priority[a.entity] - priority[b.entity] || compareQueued(a, b))
        const seen = new Set<string>()
        const result: typeof rows = []
        const at = timestamp()
        for (const row of rows) {
          const key = `${row.entity}:${row.entity_id}`
          if (seen.has(key)) continue
          seen.add(key)
          if (
            !allowed.has(row.collection_id) ||
            row.in_flight ||
            (row.next_attempt_at && row.next_attempt_at > at)
          )
            continue
          if (row.entity === 'item' && !syncedItems.has(row.entity_id)) continue
          if (row.entity === 'entry' || row.entity === 'photo') {
            const record = await (row.entity === 'entry' ? db.entries : db.photos).get(row.entity_id)
            const itemId = record?.item_id ?? row.fields.item_id
            if (typeof itemId === 'string' && !syncedItems.has(itemId)) continue
            if (typeof itemId !== 'string' && row.op !== 'purge') continue
          }
          result.push(row)
          if (result.length === 200) break
        }
        if (signal.aborted) return []
        for (const row of result) await db.outbox.update(row.id, { in_flight: true, sent: true })
        return result
      },
    )
    if (!selected.length) return true
    try {
      signal.throwIfAborted()
      const response = await fetcher('/api/sync/batch', {
        signal,
        method: 'POST',
        credentials: 'same-origin',
        headers: requestHeaders('POST', { 'Content-Type': 'application/json' }),
        body: JSON.stringify({
          schema: 2,
          device_id: deviceId?.value ?? 'local-device',
          mutations: selected.map((item) => ({
            id: item.id,
            entity: item.entity,
            entity_id: item.entity_id,
            collection_id: item.collection_id,
            op: item.op,
            base_revision: item.base_revision,
            fields: item.fields,
          })),
        }),
      })
      if (await haltOnStatus(response.status)) {
        await db.transaction('rw', db.outbox, async () => {
          for (const item of selected) await db.outbox.update(item.id, { in_flight: false })
        })
        return false
      }
      if (response.status === 409) {
        let code = ''
        try {
          const body = (await response.clone().json()) as { code?: string; detail?: string }
          code = body.code ?? body.detail ?? ''
        } catch {
          /* ignored */
        }
        if (code === 'client_outdated') {
          await db.transaction('rw', db.outbox, async () => {
            for (const item of selected)
              await db.outbox.update(item.id, {
                in_flight: false,
                last_error: 'Update the app to keep syncing.',
              })
          })
          lastError = 'Update the app to keep syncing.'
          phase = 'error'
          return true
        }
      }
      if (!response.ok)
        throw Object.assign(new Error(`Sync request failed (${response.status}).`), {
          status: response.status,
        })
      const data = (await response.json()) as { results: BatchResult[] }
      const results = new Map(data.results.map((result) => [result.id, result]))
      for (const item of selected) {
        const result = results.get(item.id)
        if (!result) throw new Error('The server did not acknowledge every change.')
        await applyResult(item, result)
      }
      return true
    } catch (error) {
      await db.transaction('rw', db.outbox, async () => {
        for (const item of selected) {
          const current = await db.outbox.get(item.id)
          if (!current) continue
          if (signal.aborted) {
            await db.outbox.update(item.id, { in_flight: false })
            continue
          }
          const attempts = current.attempts + 1
          const delay = Math.min(300_000, 2_000 * 2 ** Math.min(attempts - 1, 8))
          await db.outbox.put({
            ...current,
            in_flight: false,
            attempts,
            next_attempt_at: new Date(now().getTime() + delay).toISOString(),
            last_error: userError(error),
          })
        }
      })
      if (!signal.aborted) {
        lastError = userError(error)
        phase = 'error'
      }
      return false
    }
  }

  async function applyResult(item: OutboxItem, result: BatchResult) {
    if (!item) return
    const outcome: BatchResult =
      result.status === 'duplicate' && result.code
        ? {
            ...result,
            status: ['field_conflict', 'sequence_taken'].includes(result.code) ? 'conflict' : 'rejected',
          }
        : result
    await db.transaction(
      'rw',
      [db.collections, db.items, db.entries, db.photos, db.outbox, db.conflicts],
      async () => {
        const current = await db.outbox.get(item.id)
        if (!current) return
        const table =
          item.entity === 'collection'
            ? db.collections
            : item.entity === 'item'
              ? db.items
              : item.entity === 'entry'
                ? db.entries
                : db.photos
        const record = (await table.get(item.entity_id)) as Collection | Item | Entry | Photo | undefined
        if (outcome.status === 'applied' || outcome.status === 'duplicate') {
          await db.outbox.delete(item.id)
          if (record) {
            const remaining = await db.outbox
              .where('[entity+entity_id]')
              .equals([item.entity, item.entity_id])
              .toArray()
            if (outcome.record && outcome.server_revision !== null) {
              const revisions = (outcome.record.field_revisions ?? {}) as Record<string, number>
              for (const row of remaining) {
                if (!isUnsent(row) || (row.base_revision ?? 0) >= outcome.server_revision) continue
                const safeToRebase =
                  (row.base_revision === null && item.op === 'upsert' && item.base_revision === null) ||
                  Object.keys(row.fields).every(
                    (field) => field in item.fields || (revisions[field] ?? 0) <= (row.base_revision ?? 0),
                  )
                if (safeToRebase) await db.outbox.put({ ...row, base_revision: outcome.server_revision })
              }
            }
            const stillPending = remaining.length > 0
            await table.put({
              ...record,
              server_revision:
                outcome.server_revision === null
                  ? null
                  : Math.max(record.server_revision ?? 0, outcome.server_revision),
              sync_state:
                (await db.conflicts
                  .where('[entity+entity_id]')
                  .equals([item.entity, item.entity_id])
                  .count()) > 0
                  ? 'conflict'
                  : stillPending
                    ? record.sync_state
                    : 'synced',
            } as never)
          }
          return
        }
        if (outcome.status === 'conflict' && outcome.code === 'field_conflict' && record) {
          const fields = outcome.conflicting_fields ?? []
          const serverRecord: ServerRecord = outcome.record ?? { id: item.entity_id }
          if (outcome.server_revision === null) throw new Error('The conflict has no server revision.')
          const conflict: SyncConflict = {
            id: createId(),
            collection_id: item.collection_id,
            entity: item.entity,
            entity_id: item.entity_id,
            fields,
            local_values: Object.fromEntries(fields.map((field) => [field, item.fields[field]])),
            server_values: Object.fromEntries(fields.map((field) => [field, serverRecord[field]])),
            server_revision: outcome.server_revision,
            created_at: timestamp(),
          }
          await db.conflicts.put(conflict)
          await db.outbox.delete(item.id)
          // The server rejects the whole mutation, including otherwise safe edits.
          const rest = Object.fromEntries(
            Object.entries(item.fields).filter(([field]) => !fields.includes(field)),
          )
          if (item.op === 'upsert') delete rest.deleted_at
          if (Object.keys(rest).length && item.op !== 'purge') {
            await db.outbox.add({
              ...newMutationId(current),
              op: deletionOperation(rest) ?? 'upsert',
              base_revision: outcome.server_revision,
              fields: rest,
            })
          }
          await table.put({ ...record, sync_state: 'conflict' } as never)
          return
        }
        if (outcome.status === 'conflict' && outcome.code === 'sequence_taken' && item.entity === 'entry') {
          const collection = await db.collections.get(item.collection_id)
          const serverNext = Number(outcome.record?.next_sequence_number ?? 1)
          if (collection && record && !record.server_revision) {
            const next = Math.max(collection.next_sequence_number, serverNext)
            const updatedCollection = {
              ...collection,
              next_sequence_number: next + 1,
              updated_at: timestamp(),
              revision: collection.revision + 1,
              sync_state: 'pending' as const,
            }
            await db.collections.put(updatedCollection)
            await queueMutation(
              db,
              updatedCollection,
              'collection',
              updatedCollection,
              'upsert',
              {
                next_sequence_number: updatedCollection.next_sequence_number,
              },
              timestamp(),
            )
            await db.entries.put({ ...(record as Entry), sequence_number: next, sync_state: 'pending' })
            const replacement = {
              ...newMutationId(current),
              fields: { ...current.fields, sequence_number: next },
            }
            await db.outbox.delete(item.id)
            await db.outbox.put(replacement)
          }
          return
        }
        if (
          outcome.code === 'missing_parent' &&
          current.base_revision === null &&
          (current.op === 'delete' || current.op === 'restore') &&
          (current.entity === 'entry' || current.entity === 'photo') &&
          record?.server_revision === null
        ) {
          await db.outbox.delete(current.id)
          await db.outbox.add(repairMissingCreate(newMutationId(current), record as Entry | Photo))
          return
        }
        const message = outcome.message ?? 'The server rejected this change.'
        await db.outbox.put({
          ...current,
          in_flight: false,
          attempts: current.attempts + 1,
          next_attempt_at: new Date(
            now().getTime() + Math.min(300_000, 5_000 * 2 ** Math.min(current.attempts, 6)),
          ).toISOString(),
          last_error: message,
        })
        if (record) await table.put({ ...record, sync_state: 'error' } as never)
      },
    )
  }

  async function canUpload(itemId: Id) {
    const entries = await db.entries.where('item_id').equals(itemId).toArray()
    const collections = await db.collections.bulkGet(entries.map((entry) => entry.collection_id))
    return (
      collections.some((collection) => collection?.storage_mode === 'synced') &&
      !collections.some((collection) => collection?.storage_mode === 'local_only')
    )
  }

  async function upload(photoId: Id, signal: AbortSignal) {
    const photo = await db.transaction('rw', [db.photos, db.entries, db.collections], async () => {
      const current = await db.photos.get(photoId)
      if (
        signal.aborted ||
        !current ||
        current.server_revision === null ||
        !['pending', 'error'].includes(current.upload_state) ||
        (current.upload_next_attempt_at && current.upload_next_attempt_at > timestamp()) ||
        !(await canUpload(current.item_id))
      )
        return
      await db.photos.update(photoId, { upload_state: 'uploading' })
      return current
    })
    if (!photo) return true

    const url = `/api/photos/${encodeURIComponent(photoId)}`
    const updateClaim = (patch: Partial<PhotoWithUploadRetry>) =>
      db.photos
        .where('id')
        .equals(photoId)
        .filter((photo) => photo.upload_state === 'uploading')
        .modify(patch)
    const markUploaded = (serverKey?: string) =>
      updateClaim({
        upload_state: 'uploaded',
        ...(serverKey ? { server_storage_key: serverKey } : {}),
        upload_attempts: 0,
        upload_next_attempt_at: null,
        upload_error: null,
      })
    const markFailed = async (message: string, retryAt: number, attempts: number) => {
      await updateClaim({
        upload_state: 'error',
        upload_attempts: attempts,
        upload_next_attempt_at: new Date(retryAt).toISOString(),
        upload_error: message,
      })
      lastError ??= message
    }
    try {
      signal.throwIfAborted()
      const head = await fetcher(`${url}/original`, {
        method: 'HEAD',
        cache: 'no-store',
        credentials: 'same-origin',
        signal,
      })
      if (await haltOnStatus(head.status)) {
        if (head.status === 507) await markFailed(storageLow, uploadRetryAt, photo.upload_attempts ?? 0)
        return false
      }
      if (head.ok && head.headers.get('ETag')?.replaceAll('"', '') === photo.sha256) {
        await markUploaded()
        return true
      }
      if (!head.ok && head.status !== 404) throw new Error(`Photo check failed (${head.status}).`)
      const blob = await readPhotoBlob(photo.id, options.repoDbName)
      if (!(await canUpload(photo.item_id))) return true
      if (!blob) throw new Error('The original photo is missing from this device.')
      signal.throwIfAborted()
      const put = await fetcher(`${url}/original`, {
        method: 'PUT',
        credentials: 'same-origin',
        signal,
        headers: requestHeaders('PUT', {
          'Content-Type': photo.mime_type,
          'X-Content-SHA256': photo.sha256,
        }),
        body: blob.original,
      })
      if (await haltOnStatus(put.status)) {
        if (put.status === 507) await markFailed(storageLow, uploadRetryAt, photo.upload_attempts ?? 0)
        return false
      }
      if (!put.ok) throw new Error(`Photo upload failed (${put.status}).`)
      const result = (await put.json()) as { sha256: string; byte_size: number; server_storage_key: string }
      if (result.sha256 !== photo.sha256 || result.byte_size !== photo.byte_size)
        throw new Error('The uploaded photo did not match its local checksum.')
      await markUploaded(result.server_storage_key)
      if (!blob.thumbnail || signal.aborted || !(await canUpload(photo.item_id))) return true
      try {
        signal.throwIfAborted()
        const thumb = await fetcher(`${url}/thumbnail`, {
          method: 'PUT',
          credentials: 'same-origin',
          signal,
          headers: requestHeaders('PUT', { 'Content-Type': 'image/jpeg' }),
          body: blob.thumbnail,
        })
        if (await haltOnStatus(thumb.status)) return false
      } catch {
        // Thumbnails are optional and can be regenerated.
      }
      return true
    } catch (error) {
      if (signal.aborted) return false
      const attempts = (photo.upload_attempts ?? 0) + 1
      const delay = Math.min(300_000, 2_000 * 2 ** Math.min(attempts - 1, 8))
      await markFailed(userError(error), now().getTime() + delay, attempts)
      // A transport failure can affect the whole queue. A per-photo error lets other photos proceed.
      return !(error instanceof TypeError)
    } finally {
      await updateClaim({ upload_state: photo.upload_state })
    }
  }

  async function pull(signal: AbortSignal) {
    let cursor = await db.settings.get(SETTING_KEYS.syncCursor).then((row) => Number(row?.value ?? 0))
    let more = true
    while (more && !signal.aborted) {
      const response = await fetcher(`/api/sync/changes?cursor=${cursor}&limit=500&schema=2`, {
        credentials: 'same-origin',
        signal,
      })
      if (await haltOnStatus(response.status)) return false
      if (response.status === 409) {
        let detail = ''
        try {
          const body = (await response.clone().json()) as { code?: string; detail?: string }
          detail = body.code ?? body.detail ?? ''
        } catch {
          // Keep the status fallback for malformed responses.
        }
        if (detail === 'client_outdated') throw new Error('Update the app to keep syncing.')
      }
      if (!response.ok) throw new Error(`Changes request failed (${response.status}).`)
      const page = (await response.json()) as {
        changes: Array<{
          seq: number
          entity: 'collection' | 'item' | 'entry' | 'photo'
          id: Id
          record?: ServerRecord
          purged?: boolean
          removed?: boolean
        }>
        cursor: number
        has_more: boolean
      }
      signal.throwIfAborted()
      for (const change of page.changes) await mergeChange(change)
      cursor = page.cursor
      await db.settings.put({ key: SETTING_KEYS.syncCursor, value: cursor })
      more = page.has_more
    }
    return !signal.aborted
  }

  async function mergeChange(change: {
    entity: 'collection' | 'item' | 'entry' | 'photo'
    id: Id
    record?: ServerRecord
    purged?: boolean
    removed?: boolean
  }) {
    await db.transaction(
      'rw',
      [db.collections, db.items, db.entries, db.photos, db.photoBlobs, db.outbox, db.conflicts],
      async () => {
        const deleteUnusedItem = async (itemId: Id) => {
          if (await db.entries.where('item_id').equals(itemId).count()) return
          const photoIds = await db.photos.where('item_id').equals(itemId).primaryKeys()
          await db.photoBlobs.bulkDelete(photoIds)
          await db.photos.bulkDelete(photoIds)
          await db.items.delete(itemId)
        }
        const table =
          change.entity === 'collection'
            ? db.collections
            : change.entity === 'item'
              ? db.items
              : change.entity === 'entry'
                ? db.entries
                : db.photos
        const old = (await table.get(change.id)) as Collection | Item | Entry | Photo | undefined
        if (change.purged || change.removed) {
          if (
            change.entity === 'collection' &&
            (old as Collection | undefined)?.storage_mode === 'local_only'
          )
            return
          if (change.entity === 'entry' && old) {
            const owner = await db.collections.get((old as Entry).collection_id)
            if (owner?.storage_mode === 'local_only') return
          }
          if ((change.entity === 'item' || change.entity === 'photo') && old) {
            const itemId = change.entity === 'item' ? change.id : (old as Photo).item_id
            const linked = await db.entries.where('item_id').equals(itemId).toArray()
            const owners = await Promise.all(linked.map((entry) => db.collections.get(entry.collection_id)))
            if (owners.some((owner) => owner?.storage_mode === 'local_only')) return
          }
          if (change.entity === 'collection') {
            const entries = await db.entries.where('collection_id').equals(change.id).toArray()
            await db.entries.bulkDelete(entries.map((entry) => entry.id))
            for (const entry of entries) await deleteUnusedItem(entry.item_id)
            await db.outbox.where('collection_id').equals(change.id).delete()
          } else if (change.entity === 'entry') {
            const entry = old as Entry | undefined
            if (entry) await db.entries.delete(entry.id)
            if (entry) await deleteUnusedItem(entry.item_id)
          } else {
            if (change.entity === 'item') {
              const entryIds = await db.entries.where('item_id').equals(change.id).primaryKeys()
              await db.entries.bulkDelete(entryIds)
              const photoIds = await db.photos.where('item_id').equals(change.id).primaryKeys()
              await db.photoBlobs.bulkDelete(photoIds)
              await db.photos.bulkDelete(photoIds)
              await db.items.delete(change.id)
            } else await db.photoBlobs.delete(change.id)
          }
          if (change.entity === 'collection') {
            const entries = await db.entries.where('collection_id').equals(change.id).toArray()
            await db.entries.bulkDelete(entries.map((entry) => entry.id))
            for (const entry of entries) await deleteUnusedItem(entry.item_id)
          }
          await table.delete(change.id)
          return
        }
        if (!change.record) return
        if (change.entity === 'collection' && (old as Collection | undefined)?.storage_mode === 'local_only')
          return
        const incoming: ServerRecord = {
          ...change.record,
          ...(change.entity === 'collection' ? { folder: change.record.folder ?? '' } : {}),
          ...(change.entity === 'entry'
            ? { entry_notes: change.record.entry_notes ?? '', starred_at: change.record.starred_at ?? null }
            : {}),
        }
        const collectionId = change.entity === 'collection' ? change.id : String(incoming.collection_id ?? '')
        if (change.entity === 'item' || change.entity === 'photo') {
          const localEntries = await db.entries
            .where('item_id')
            .equals(change.entity === 'item' ? change.id : String(incoming.item_id))
            .toArray()
          const localCollections = await Promise.all(
            localEntries.map((entry) => db.collections.get(entry.collection_id)),
          )
          if (localCollections.some((collection) => collection?.storage_mode === 'local_only')) return
        }
        if (change.entity === 'entry') {
          const collection = await db.collections.get(collectionId)
          if (!collection || collection.storage_mode !== 'synced') return
        }
        const pending = await db.outbox
          .where('[entity+entity_id]')
          .equals([change.entity, change.id])
          .toArray()
        const conflictRows = await db.conflicts
          .where('[entity+entity_id]')
          .equals([change.entity, change.id])
          .toArray()
        const collectionNextSequence =
          change.entity === 'collection'
            ? Math.max(
                Number(incoming.next_sequence_number ?? 1),
                Number((old as Collection | undefined)?.next_sequence_number ?? 1),
                ...(await db.entries.where('collection_id').equals(change.id).toArray()).map(
                  (entry) => entry.sequence_number + 1,
                ),
              )
            : undefined
        if (!old) {
          const merged = {
            ...incoming,
            ...(collectionNextSequence === undefined ? {} : { next_sequence_number: collectionNextSequence }),
            server_revision: incoming.revision ?? incoming.server_revision ?? null,
            sync_state: conflictRows.length ? 'conflict' : 'synced',
            ...(change.entity === 'photo'
              ? { upload_state: incoming.server_storage_key ? 'uploaded' : 'pending' }
              : {}),
          }
          await table.put(merged as never)
          return
        }
        const pendingFields = new Set([
          ...pending.flatMap((item) => Object.keys(item.fields)),
          ...conflictRows.flatMap((row) => row.fields),
        ])
        const merged = {
          ...incoming,
          ...Object.fromEntries(Object.entries(old).filter(([key]) => pendingFields.has(key))),
          // The counter only grows: never let a pulled or stale pending value lower it.
          ...(collectionNextSequence === undefined ? {} : { next_sequence_number: collectionNextSequence }),
          ...(change.entity === 'photo'
            ? {
                upload_state: (old as Photo).upload_state,
                upload_attempts: (old as PhotoWithUploadRetry)?.upload_attempts,
                upload_next_attempt_at: (old as PhotoWithUploadRetry)?.upload_next_attempt_at,
                upload_error: (old as PhotoWithUploadRetry)?.upload_error,
              }
            : {}),
          server_revision: incoming.revision ?? incoming.server_revision ?? old.server_revision,
          sync_state: conflictRows.length ? 'conflict' : pending.length ? old.sync_state : 'synced',
        }
        await table.put(merged as never)
      },
    )
  }

  async function sync(signal: AbortSignal) {
    if (needsRepair) {
      await repairSyncQueue(db)
      needsRepair = false
    }
    if (authBlocked) {
      phase = 'signed_out'
      return
    }
    if (typeof navigator !== 'undefined' && !navigator.onLine) {
      phase = 'offline'
      return
    }

    signal.throwIfAborted()
    phase = 'syncing'
    uploadRetryAt = await storedUploadRetryAt()
    signal.throwIfAborted()
    lastError = uploadRetryAt > now().getTime() ? storageLow : null
    const response = await fetcher('/api/auth/session', { credentials: 'same-origin', method: 'GET', signal })
    if (await haltOnStatus(response.status)) return
    if (!response.ok) throw new Error(`Session request failed (${response.status}).`)
    authenticated = ((await response.json()) as { authenticated: boolean }).authenticated
    if (!authenticated) {
      await haltOnStatus(401)
      return
    }
    if (!(await push(signal)) || !(await pull(signal))) return

    if (uploadRetryAt <= now().getTime()) {
      const collections = await db.collections.toArray()
      const syncedItems = await syncedItemIds(db, collections)
      const photos = (await db.photos.toArray())
        .filter(
          (photo) =>
            syncedItems.has(photo.item_id) &&
            photo.server_revision !== null &&
            ['pending', 'error'].includes(photo.upload_state) &&
            (!photo.upload_next_attempt_at || photo.upload_next_attempt_at <= timestamp()),
        )
        .sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id))
      for (const [index, photo] of photos.entries()) {
        if (signal.aborted || authBlocked || !(await upload(photo.id, signal)) || !(await push(signal)))
          return
        if ((index % 2 === 1 || index === photos.length - 1) && !(await pull(signal))) return
      }
    }
    phase = lastError ? 'error' : 'idle'
    lastSuccess = timestamp()
  }

  async function runCycle() {
    if (running) {
      rerun = true
      return running
    }
    const abort = new AbortController()
    controller.current = abort
    running = (async () => {
      try {
        // A second browser tab must not recover an active upload or send it again.
        if (typeof navigator !== 'undefined' && navigator.locks) {
          await navigator.locks.request(`capture-sync:${db.name}`, { signal: abort.signal }, () =>
            sync(abort.signal),
          )
        } else await sync(abort.signal)
      } catch (error) {
        if (!abort.signal.aborted) {
          lastError = userError(error)
          phase = 'error'
        }
      } finally {
        if (phase === 'syncing') phase = lastError ? 'error' : 'idle'
        controller.current = null
        await refreshStatus()
      }
    })().finally(async () => {
      running = null
      if (rerun) {
        rerun = false
        await runCycle()
      }
    })
    return running
  }

  // Connectivity changes can clear transport backoff. Only Sync Now can override a 507.
  const clearBackoff = async (force: boolean) => {
    await db.transaction('rw', [db.outbox, db.photos, db.settings], async () => {
      await db.outbox
        .filter((item) => !item.in_flight && !!item.next_attempt_at)
        .modify({ next_attempt_at: null })
      if (force || (await storedUploadRetryAt()) <= now().getTime()) {
        await db.settings.delete(storageRetryKey)
        await db.photos
          .filter((photo) => !!photo.upload_next_attempt_at)
          .modify({ upload_next_attempt_at: null })
      }
    })
  }
  const retryNow = async () => {
    await clearBackoff(true)
    await runCycle()
  }
  const onOnline = () => {
    void clearBackoff(false).then(runCycle)
  }
  const onVisibility = () => {
    if (document.visibilityState === 'visible') void runCycle()
  }
  const onAuthenticated = () => {
    authBlocked = false
    void runCycle()
  }
  const onSignedOut = () => {
    authBlocked = true
    authenticated = false
    phase = 'signed_out'
    controller.current?.abort()
    void refreshStatus()
  }
  window.addEventListener('capture:authenticated', onAuthenticated)
  window.addEventListener('capture:signed-out', onSignedOut)
  function start() {
    if (started) return
    started = true
    needsRepair = true
    window.addEventListener('online', onOnline)
    window.addEventListener('capture:authenticated', onAuthenticated)
    window.addEventListener('capture:signed-out', onSignedOut)
    document.addEventListener('visibilitychange', onVisibility)
    timer = setInterval(() => {
      if (navigator.onLine && document.visibilityState === 'visible') void runCycle()
    }, options.intervalMs ?? 30_000)
    const outboxSubscription = liveQuery(() => db.outbox.toArray()).subscribe((rows) => {
      if (!rows.length || !started) return
      clearTimeout(debounce)
      debounce = setTimeout(() => {
        void runCycle()
      }, 1_500)
    })
    unsubscribeOutbox = () => outboxSubscription.unsubscribe()
    void runCycle()
  }
  function stop() {
    started = false
    rerun = false
    window.removeEventListener('online', onOnline)
    document.removeEventListener('visibilitychange', onVisibility)
    window.removeEventListener('capture:authenticated', onAuthenticated)
    window.removeEventListener('capture:signed-out', onSignedOut)
    if (timer) clearInterval(timer)
    if (debounce) clearTimeout(debounce)
    unsubscribeOutbox?.()
    unsubscribeOutbox = undefined
    controller.current?.abort()
  }
  async function resolveConflict(conflictId: Id, choice: 'mine' | 'server') {
    await db.transaction(
      'rw',
      [db.conflicts, db.collections, db.items, db.entries, db.photos, db.outbox],
      async () => {
        const conflict = await db.conflicts.get(conflictId)
        if (!conflict) return
        const table =
          conflict.entity === 'collection'
            ? db.collections
            : conflict.entity === 'item'
              ? db.items
              : conflict.entity === 'entry'
                ? db.entries
                : db.photos
        const record = (await table.get(conflict.entity_id)) as Collection | Item | Entry | Photo | undefined
        const collection = await db.collections.get(conflict.collection_id)
        if (record && collection) {
          if (choice === 'server') {
            await table.put({
              ...record,
              ...conflict.server_values,
              server_revision: conflict.server_revision,
              sync_state: 'synced',
            } as never)
          } else {
            if (collection.storage_mode !== 'synced') {
              await db.conflicts.delete(conflictId)
              return
            }
            const fields = { ...conflict.local_values }
            await queueMutation(
              db,
              collection,
              conflict.entity,
              record,
              deletionOperation(fields) ?? 'upsert',
              fields,
              timestamp(),
              conflict.server_revision,
              false,
            )
            await table.put({
              ...record,
              ...fields,
              server_revision: Math.max(record.server_revision ?? 0, conflict.server_revision),
              sync_state: 'pending',
            } as never)
          }
        }
        await db.conflicts.delete(conflictId)
      },
    )
    void runCycle()
  }
  return { status, conflicts, start, stop, syncNow: retryNow, resolveConflict, runScheduledCycle: runCycle }
}

export const syncEngine = createSyncEngine()
