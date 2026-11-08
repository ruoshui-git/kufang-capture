import { liveQuery } from 'dexie'
import { createId } from '../ids'
import { getCaptureDb } from '../db'
import { SETTING_KEYS, type Collection, type Entry, type Id, type OutboxItem, type Photo } from '../types'
import type { Watchable } from '../repo'
import type { AuthClient, ServerClient, SyncConflict, SyncEngine, SyncStatus } from './api'

type FetchLike = typeof fetch
type RetriablePhoto = Photo & { upload_attempts?: number; upload_next_attempt_at?: string | null }
type ServerRecord = Record<string, unknown> & { id: Id; revision?: number; server_revision?: number }
type BatchResult = {
  id: Id
  status: 'applied' | 'duplicate' | 'conflict' | 'rejected'
  server_revision: number
  record?: ServerRecord
  code?: string
  message?: string
  conflicting_fields?: string[]
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
        try {
          await request('/api/auth/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ password }),
          })
          if (typeof window !== 'undefined') window.dispatchEvent(new Event('capture:authenticated'))
        } catch (error) {
          throw new Error(userError(error))
        }
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

export const { authClient, serverClient } = makeClients(fetch)

export function createSyncEngine(options: SyncEngineOptions = {}): SyncEngine {
  const db = getCaptureDb(options.repoDbName)
  const fetcher = options.fetch ?? fetch
  const clients = makeClients(fetcher)
  const now = options.now ?? (() => new Date())
  const timestamp = () => now().toISOString()
  const controller = { current: null as AbortController | null }
  let phase: SyncStatus['phase'] = 'idle'
  let authenticated: boolean | null = null
  let lastSuccess: string | null = null
  let lastError: string | null = null
  let running: Promise<void> | null = null
  let rerun = false
  let uploadsPaused = false
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
      const mutations = items.filter((item) => item.collection_id === collection.id)
      const pendingPhotos = photos.filter(
        (photo) =>
          photo.collection_id === collection.id &&
          ['pending', 'uploading', 'error'].includes(photo.upload_state),
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

  async function eligibleItems(): Promise<OutboxItem[]> {
    const collections = await db.collections.toArray()
    const allowed = new Set(collections.filter((c) => c.storage_mode === 'synced').map((c) => c.id))
    return (await db.outbox.toArray())
      .filter((item) => allowed.has(item.collection_id))
      .sort((a, b) => {
        const collectionPriority = Number(b.entity === 'collection') - Number(a.entity === 'collection')
        return collectionPriority || a.created_at.localeCompare(b.created_at)
      })
  }

  async function push() {
    const selected = (await eligibleItems())
      .filter((item) => !item.in_flight && (!item.next_attempt_at || item.next_attempt_at <= timestamp()))
      .slice(0, 200)
    const collections = await db.collections.toArray()
    const modes = new Map(collections.map((collection) => [collection.id, collection.storage_mode]))
    if (selected.some((item) => modes.get(item.collection_id) !== 'synced'))
      throw new Error('Safety check failed: Local Only data cannot be sent.')
    if (!selected.length) return
    await db.transaction('rw', db.outbox, async () => {
      for (const item of selected) await db.outbox.update(item.id, { in_flight: true })
    })
    const deviceId = await db.settings.get(SETTING_KEYS.deviceId)
    try {
      const response = await fetcher('/api/sync/batch', {
        method: 'POST',
        credentials: 'same-origin',
        headers: requestHeaders('POST', { 'Content-Type': 'application/json' }),
        body: JSON.stringify({
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
      if (response.status === 401) {
        authBlocked = true
        authenticated = false
        phase = 'signed_out'
        for (const item of selected) await db.outbox.update(item.id, { in_flight: false })
        return
      }
      if (!response.ok)
        throw Object.assign(new Error(`Sync request failed (${response.status}).`), {
          status: response.status,
        })
      const data = (await response.json()) as { results: BatchResult[] }
      for (const result of data.results)
        await applyResult(
          selected.find((item) => item.id === result.id)!,
          result,
        )
    } catch (error) {
      const statusCode = (error as { status?: number }).status
      if (statusCode === 401) {
        authBlocked = true
        authenticated = false
        phase = 'signed_out'
      }
      await db.transaction('rw', db.outbox, async () => {
        for (const item of selected) {
          const current = await db.outbox.get(item.id)
          if (!current) continue
          const attempts = current.attempts + 1
          const delay = Math.min(300_000, 2_000 * 2 ** Math.min(attempts - 1, 8))
          await db.outbox.put({
            ...current,
            in_flight: false,
            attempts,
            next_attempt_at: new Date(now().getTime() + delay * (0.75 + Math.random() * 0.5)).toISOString(),
            last_error: userError(error),
          })
        }
      })
      lastError = userError(error)
      if (statusCode !== 401) phase = 'error'
    }
  }

  async function applyResult(item: OutboxItem, result: BatchResult) {
    if (!item) return
    await db.transaction('rw', db.collections, db.entries, db.photos, db.outbox, db.conflicts, async () => {
      const current = await db.outbox.get(item.id)
      if (!current) return
      const table =
        item.entity === 'collection' ? db.collections : item.entity === 'entry' ? db.entries : db.photos
      const record = (await table.get(item.entity_id)) as Collection | Entry | Photo | undefined
      if (result.status === 'applied' || result.status === 'duplicate') {
        await db.outbox.delete(item.id)
        if (record) {
          const stillPending =
            (await db.outbox
              .where('[collection_id+entity+entity_id]')
              .equals([item.collection_id, item.entity, item.entity_id])
              .count()) > 0
          await table.put({
            ...record,
            server_revision: result.server_revision,
            sync_state: stillPending ? record.sync_state : 'synced',
          } as never)
        }
        return
      }
      if (result.status === 'conflict' && result.code === 'field_conflict' && record) {
        const fields = result.conflicting_fields ?? []
        const serverRecord: ServerRecord = result.record ?? { id: item.entity_id }
        const conflict: SyncConflict = {
          id: createId(),
          collection_id: item.collection_id,
          entity: item.entity,
          entity_id: item.entity_id,
          fields,
          local_values: Object.fromEntries(fields.map((field) => [field, item.fields[field]])),
          server_values: Object.fromEntries(fields.map((field) => [field, serverRecord[field]])),
          server_revision: result.server_revision,
          created_at: timestamp(),
        }
        await db.conflicts.put(conflict)
        await db.outbox.delete(item.id)
        await table.put({ ...record, sync_state: 'conflict' } as never)
        return
      }
      if (result.status === 'conflict' && result.code === 'sequence_taken' && item.entity === 'entry') {
        const collection = await db.collections.get(item.collection_id)
        const serverNext = Number(result.record?.next_sequence_number ?? 1)
        if (collection && record && !record.server_revision) {
          const next = Math.max(collection.next_sequence_number, serverNext)
          await db.collections.put({ ...collection, next_sequence_number: next + 1 })
          await db.entries.put({ ...(record as Entry), sequence_number: next, sync_state: 'pending' })
          const replacement = {
            ...current,
            id: createId(),
            fields: { ...current.fields, sequence_number: next },
            in_flight: false,
            attempts: 0,
            next_attempt_at: null,
            last_error: null,
          }
          await db.outbox.delete(item.id)
          await db.outbox.put(replacement)
        }
        return
      }
      const message = result.message ?? 'The server rejected this change.'
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
    })
  }

  async function upload() {
    if (uploadsPaused) return
    const collections = await db.collections.toArray()
    const modes = new Map(collections.map((c) => [c.id, c.storage_mode]))
    const photos = (await db.photos.toArray())
      .filter(
        (photo) =>
          modes.get(photo.collection_id) === 'synced' &&
          ['pending', 'error'].includes(photo.upload_state) &&
          photo.server_revision !== null &&
          (!(photo as RetriablePhoto).upload_next_attempt_at ||
            (photo as RetriablePhoto).upload_next_attempt_at! <= timestamp()),
      )
      .sort((a, b) => a.created_at.localeCompare(b.created_at))
    for (const photo of photos) {
      if (controller.current?.signal.aborted) return
      const collection = await db.collections.get(photo.collection_id)
      if (!collection || collection.storage_mode !== 'synced') continue
      const entry = await db.entries.get(photo.entry_id)
      if (!entry || photo.server_revision === null) continue
      try {
        const response = await fetcher(`/api/photos/${encodeURIComponent(photo.id)}/original`, {
          method: 'HEAD',
          credentials: 'same-origin',
          signal: controller.current?.signal,
        })
        if (response.status === 401) {
          authBlocked = true
          authenticated = false
          phase = 'signed_out'
          return
        }
        if (response.ok && response.headers.get('ETag')?.replaceAll('"', '') === photo.sha256) {
          await db.photos.update(photo.id, {
            upload_state: 'uploaded',
            upload_attempts: 0,
            upload_next_attempt_at: null,
          })
          continue
        }
        if (!response.ok && response.status !== 404)
          throw new Error(`Photo check failed (${response.status}).`)
        const blob = await db.photoBlobs.get(photo.id)
        if (!blob) continue
        await db.photos.update(photo.id, { upload_state: 'uploading' })
        const put = await fetcher(`/api/photos/${encodeURIComponent(photo.id)}/original`, {
          method: 'PUT',
          credentials: 'same-origin',
          signal: controller.current?.signal,
          headers: requestHeaders('PUT', {
            'Content-Type': photo.mime_type,
            'X-Content-SHA256': photo.sha256,
          }),
          body: blob.original,
        })
        if (put.status === 507) {
          uploadsPaused = true
          await db.photos.update(photo.id, { upload_state: 'error' })
          lastError = 'Server storage is low'
          return
        }
        if (put.status === 401) {
          authBlocked = true
          authenticated = false
          phase = 'signed_out'
          await db.photos.update(photo.id, { upload_state: 'pending' })
          return
        }
        if (!put.ok) throw new Error(`Photo upload failed (${put.status}).`)
        const result = (await put.json()) as {
          sha256: string
          byte_size: number
          server_storage_key: string
        }
        if (result.sha256 !== photo.sha256 || result.byte_size !== photo.byte_size)
          throw new Error('The uploaded photo did not match its local checksum.')
        await db.photos.update(photo.id, {
          upload_state: 'uploaded',
          server_storage_key: result.server_storage_key,
          upload_attempts: 0,
          upload_next_attempt_at: null,
        })
        if (blob.thumbnail) {
          try {
            await fetcher(`/api/photos/${encodeURIComponent(photo.id)}/thumbnail`, {
              method: 'PUT',
              credentials: 'same-origin',
              signal: controller.current?.signal,
              headers: requestHeaders('PUT', { 'Content-Type': 'image/jpeg' }),
              body: blob.thumbnail,
            })
          } catch {
            /* Thumbnails are optional and can be regenerated. */
          }
        }
      } catch (error) {
        if (controller.current?.signal.aborted) return
        const current = (await db.photos.get(photo.id)) as RetriablePhoto | undefined
        if (current) {
          const attempts = (current.upload_attempts ?? 0) + 1
          const delay = Math.min(300_000, 2_000 * 2 ** Math.min(attempts - 1, 8))
          await db.photos.update(photo.id, {
            upload_state: 'error',
            upload_attempts: attempts,
            upload_next_attempt_at: new Date(
              now().getTime() + delay * (0.75 + Math.random() * 0.5),
            ).toISOString(),
          })
        }
        lastError = userError(error)
        return
      }
    }
  }

  async function pull() {
    let cursor = await db.settings.get(SETTING_KEYS.syncCursor).then((row) => Number(row?.value ?? 0))
    let more = true
    while (more && !controller.current?.signal.aborted) {
      const response = await fetcher(`/api/sync/changes?cursor=${cursor}&limit=500`, {
        credentials: 'same-origin',
        signal: controller.current?.signal,
      })
      if (response.status === 401) {
        authBlocked = true
        authenticated = false
        phase = 'signed_out'
        return
      }
      if (!response.ok) throw new Error(`Changes request failed (${response.status}).`)
      const page = (await response.json()) as {
        changes: Array<{
          seq: number
          entity: 'collection' | 'entry' | 'photo'
          id: Id
          record?: ServerRecord
          purged?: boolean
          removed?: boolean
        }>
        cursor: number
        has_more: boolean
      }
      for (const change of page.changes) await mergeChange(change)
      cursor = page.cursor
      await db.settings.put({ key: SETTING_KEYS.syncCursor, value: cursor })
      more = page.has_more
    }
  }

  async function mergeChange(change: {
    entity: 'collection' | 'entry' | 'photo'
    id: Id
    record?: ServerRecord
    purged?: boolean
    removed?: boolean
  }) {
    await db.transaction('rw', db.collections, db.entries, db.photos, db.photoBlobs, db.outbox, async () => {
      const table =
        change.entity === 'collection' ? db.collections : change.entity === 'entry' ? db.entries : db.photos
      const old = (await table.get(change.id)) as Collection | Entry | Photo | undefined
      if (change.purged || change.removed) {
        if (change.entity === 'collection') {
          const [entries, photos] = await Promise.all([
            db.entries.where('collection_id').equals(change.id).primaryKeys(),
            db.photos.where('collection_id').equals(change.id).primaryKeys(),
          ])
          await db.photoBlobs.bulkDelete(photos)
          await db.photos.bulkDelete(photos)
          await db.entries.bulkDelete(entries)
          await db.outbox.where('collection_id').equals(change.id).delete()
        } else if (change.entity === 'entry') {
          const photos = await db.photos.where('entry_id').equals(change.id).primaryKeys()
          await db.photoBlobs.bulkDelete(photos)
          await db.photos.bulkDelete(photos)
        } else {
          await db.photoBlobs.delete(change.id)
        }
        await table.delete(change.id)
        return
      }
      if (!change.record) return
      if (change.entity === 'collection' && (old as Collection | undefined)?.storage_mode === 'local_only')
        return
      const incoming = change.record
      const collectionId = change.entity === 'collection' ? change.id : String(incoming.collection_id)
      if (change.entity !== 'collection') {
        const collection = await db.collections.get(collectionId)
        if (!collection || collection.storage_mode !== 'synced') return
      }
      const pending = await db.outbox
        .where('[collection_id+entity+entity_id]')
        .equals([collectionId, change.entity, change.id])
        .toArray()
      if (!old) {
        const merged = {
          ...incoming,
          server_revision: incoming.revision ?? incoming.server_revision ?? null,
          sync_state: 'synced',
          ...(change.entity === 'photo' ? { upload_state: 'uploaded' } : {}),
        }
        await table.put(merged as never)
        return
      }
      const pendingFields = new Set(pending.flatMap((item) => Object.keys(item.fields)))
      const merged = {
        ...incoming,
        ...Object.fromEntries(Object.entries(old).filter(([key]) => pendingFields.has(key))),
        ...(change.entity === 'photo'
          ? {
              upload_state: (old as Photo).upload_state,
              upload_attempts: (old as RetriablePhoto).upload_attempts,
              upload_next_attempt_at: (old as RetriablePhoto).upload_next_attempt_at,
            }
          : {}),
        server_revision: incoming.revision ?? incoming.server_revision ?? old.server_revision,
        sync_state: pending.length ? old.sync_state : 'synced',
      }
      await table.put(merged as never)
    })
  }

  async function runCycle() {
    if (running) {
      rerun = true
      return running
    }
    running = (async () => {
      if (authBlocked) {
        phase = 'signed_out'
        await refreshStatus()
        return
      }
      if (typeof navigator !== 'undefined' && !navigator.onLine) {
        phase = 'offline'
        await refreshStatus()
        return
      }
      phase = 'syncing'
      lastError = null
      controller.current = new AbortController()
      try {
        const session = await clients.authClient.session()
        authenticated = session.authenticated
        if (!session.authenticated) {
          authBlocked = true
          phase = 'signed_out'
          return
        }
        await push()
        if ((phase as SyncStatus['phase']) === 'signed_out') return
        await upload()
        if ((phase as SyncStatus['phase']) === 'signed_out') return
        await pull()
        if ((phase as SyncStatus['phase']) !== 'signed_out') {
          phase = 'idle'
          lastSuccess = timestamp()
        }
      } catch (error) {
        if (!controller.current?.signal.aborted) {
          await db.photos.toCollection().modify((photo) => {
            if (photo.upload_state === 'uploading') photo.upload_state = 'error'
          })
          lastError = userError(error)
          phase = 'error'
        }
      } finally {
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

  const onOnline = () => {
    void runCycle()
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
    void refreshStatus()
  }
  window.addEventListener('capture:authenticated', onAuthenticated)
  window.addEventListener('capture:signed-out', onSignedOut)
  function start() {
    if (started) return
    started = true
    void db.photos.toCollection().modify((photo) => {
      if (photo.upload_state === 'uploading') photo.upload_state = 'pending'
    })
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
    await db.transaction('rw', db.conflicts, db.collections, db.entries, db.photos, db.outbox, async () => {
      const conflict = await db.conflicts.get(conflictId)
      if (!conflict) return
      const table =
        conflict.entity === 'collection'
          ? db.collections
          : conflict.entity === 'entry'
            ? db.entries
            : db.photos
      const record = (await table.get(conflict.entity_id)) as Collection | Entry | Photo | undefined
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
          const fields = { ...conflict.local_values }
          await db.outbox.add({
            id: createId(),
            collection_id: conflict.collection_id,
            entity: conflict.entity,
            entity_id: conflict.entity_id,
            op: 'upsert',
            base_revision: conflict.server_revision,
            fields,
            created_at: timestamp(),
            attempts: 0,
            in_flight: false,
            last_error: null,
            next_attempt_at: null,
          })
          await table.put({
            ...record,
            server_revision: conflict.server_revision,
            sync_state: 'pending',
          } as never)
        }
      }
      await db.conflicts.delete(conflictId)
    })
    void runCycle()
  }
  return { status, conflicts, start, stop, syncNow: runCycle, resolveConflict }
}

export const syncEngine = createSyncEngine()
