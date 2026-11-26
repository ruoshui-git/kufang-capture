import { m } from '../paraglide/messages.js'
import Dexie, { liveQuery } from 'dexie'
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
  retargetSharedMutations,
  SERVER_REMOVED_MESSAGE,
  syncedItemIds,
  type PhotoWithUploadRetry,
  type RemoteRemoval,
} from '../db'
import {
  SETTING_KEYS,
  type Collection,
  type Entry,
  type Id,
  type Item,
  type Movement,
  type OutboxEntity,
  type OutboxItem,
  type Photo,
} from '../types'
import type { Watchable } from '../repo'
import type { SyncConflict, SyncEngine, SyncStatus } from './api'
import {
  AccountGate,
  AccountRequestError,
  accountGate,
  accountHeaders,
  accountMismatch,
  photoUploadRetryKey as storageRetryKey,
  requestHeaders,
  responseCode,
  sessionChangeKey,
  syncLeaseKey as leaseKey,
} from './binding'
import { displaySyncError, storedSyncLocale } from './errors'
export { authClient, createClients, peopleClient, serverClient } from './clients'

type FetchLike = typeof fetch
type ServerRecord = Record<string, unknown> & {
  id: Id
  revision?: number
  server_revision?: number
  deleted_at?: string | null
  field_revisions?: Record<string, number>
}
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
type SyncLease = { owner: Id; expiresAt: number; webLock?: boolean }
const leaseDuration = 30_000

function isAcknowledgedEntryEdit(row: OutboxItem, record?: { server_revision: number | null }) {
  return (
    row.entity === 'entry' &&
    record?.server_revision != null &&
    row.base_revision !== null &&
    row.op !== 'purge'
  )
}

function isCreate(row: OutboxItem) {
  return row.op === 'upsert' && row.base_revision === null
}

function carriesLegacyDeletion(row: OutboxItem, server: ServerRecord) {
  if (row.op !== 'upsert' || row.base_revision === null) return false
  if (typeof row.fields.deleted_at === 'string') return true
  // A partial edit only carries a null tombstone after an explicit restore.
  // A legacy full-record upsert needs evidence it was based on a tombstone.
  const revisions = server.field_revisions
  return (
    row.fields.deleted_at === null &&
    typeof server.deleted_at === 'string' &&
    (!Object.hasOwn(row.fields, 'id') ||
      (revisions?.deleted_at !== undefined && revisions.deleted_at <= row.base_revision))
  )
}

export interface SyncEngineOptions {
  repoDbName?: string
  fetch?: FetchLike
  now?: () => Date
  intervalMs?: number
}

function syncErrorText(error: unknown): string {
  if (error instanceof TypeError) return m.core_sync_network_failed({}, storedSyncLocale)
  return error instanceof Error ? error.message : m.core_sync_failed({}, storedSyncLocale)
}

/** The engine plus the backoff-respecting cycle that timers use (exposed for tests). */
export type SyncEngineWithSchedule = SyncEngine & { runScheduledCycle(): Promise<void> }

export function createSyncEngine(options: SyncEngineOptions = {}): SyncEngineWithSchedule {
  const db = getCaptureDb(options.repoDbName)
  const syncTables = {
    collection: db.collections,
    item: db.items,
    entry: db.entries,
    photo: db.photos,
    movement: db.movements,
  }
  const fetcher = options.fetch ?? fetch
  const gate = options.repoDbName ? new AccountGate(options.repoDbName) : accountGate
  let cycleAccount: Id | undefined
  let cycleSessionGeneration: number
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
  let needsRepair = true
  let authBlocked = false
  let clientOutdated = false
  let leaseOwner: Id | undefined
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
    const [collections, items, photos, conflictRows, records, entries] = await Promise.all([
      db.collections.toArray(),
      db.outbox.toArray(),
      db.photos.toArray(),
      db.conflicts.toArray(),
      db.items.toArray(),
      db.entries.toArray(),
    ])
    const synced = collections.filter((item) => item.storage_mode === 'synced')
    const per: SyncStatus['per_collection'] = {}
    let hasRemoval = false
    let hasPrivatePlacement = false
    const localOnlyCollections = new Set(
      collections.filter((collection) => collection.storage_mode === 'local_only').map(({ id }) => id),
    )
    const entriesByCollection = new Map<Id, typeof entries>()
    const privateItems = new Set<Id>()
    for (const entry of entries) {
      const ownEntries = entriesByCollection.get(entry.collection_id) ?? []
      ownEntries.push(entry)
      entriesByCollection.set(entry.collection_id, ownEntries)
      if (localOnlyCollections.has(entry.collection_id)) privateItems.add(entry.item_id)
    }
    const removedItems = new Set(
      records.filter((record) => record.removed_on_server).map((record) => record.id),
    )
    for (const collection of synced) {
      const ownEntries = entriesByCollection.get(collection.id) ?? []
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
          ownItems.has(photo.item_id) &&
          !photo.removed_on_server &&
          ['pending', 'uploading', 'error'].includes(photo.upload_state),
      )
      const errors =
        mutations.filter((item) => item.last_error).length +
        pendingPhotos.filter((p) => p.upload_state === 'error').length
      const removed =
        collection.removed_on_server ||
        ownEntries.some((entry) => entry.removed_on_server || removedItems.has(entry.item_id)) ||
        photos.some((photo) => photo.removed_on_server && ownItems.has(photo.item_id))
      hasRemoval ||= !!removed
      const privatePlacement = ownEntries.some(
        (entry) => !entry.removed_on_server && privateItems.has(entry.item_id),
      )
      hasPrivatePlacement ||= privatePlacement
      per[collection.id] = {
        collection_id: collection.id,
        pending_mutations: mutations.length,
        pending_uploads: pendingPhotos.length,
        pending_upload_bytes: pendingPhotos.reduce((sum, photo) => sum + photo.byte_size, 0),
        errors: errors + Number(!!removed) + Number(privatePlacement),
        conflicts: conflictRows.filter((item) => item.collection_id === collection.id).length,
        last_synced_at: null,
      }
    }
    const pendingMutations = Object.values(per).reduce((sum, item) => sum + item.pending_mutations, 0)
    const pendingPhotos = Object.values(per).reduce((sum, item) => sum + item.pending_uploads, 0)
    const storedUploadError = photos.find(
      (photo) => photo.upload_state === 'error' && photo.upload_error,
    )?.upload_error
    statusValue = {
      ...emptyStatus(),
      last_error:
        lastError ??
        (hasRemoval ? m.core_sync_removed() : null) ??
        (hasPrivatePlacement ? m.core_sync_private_placement() : null) ??
        (storedUploadError ? displaySyncError(storedUploadError) : null),
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

  liveQuery(async () => {
    await refreshStatus()
    return true
  }).subscribe()

  const storageLow = m.core_server_space_low({}, storedSyncLocale)
  const storedUploadRetryAt = async () => Number((await db.settings.get(storageRetryKey))?.value ?? 0)
  const readLease = async () => (await db.settings.get(leaseKey))?.value as SyncLease | undefined

  async function assertLease(owner = leaseOwner) {
    const lease = await readLease()
    if (lease && lease.owner === owner && lease.expiresAt > now().getTime()) return
    controller.current?.abort()
    throw new DOMException(m.core_sync_lease_expired(), 'AbortError')
  }

  // Start the request while the IndexedDB snapshot is held. Await the network
  // outside the transaction so saving locally never waits on the network.
  function startRequest(url: string, init: RequestInit) {
    const response = Dexie.ignoreTransaction(async () =>
      fetcher(url, { ...init, headers: dataHeaders(init.headers) }),
    )
    void response.catch(() => {})
    return { response }
  }

  function dataHeaders(headers?: HeadersInit) {
    const access = gate.current
    if (!cycleAccount || access.kind !== 'ready' || access.user.id !== cycleAccount)
      throw new DOMException(m.core_account_session_changed(), 'AbortError')
    return accountHeaders(cycleAccount, headers)
  }

  function showBlocked() {
    const access = gate.current
    if (access.kind !== 'blocked') return false
    rerun = false
    authenticated = true
    lastError = accountMismatch(access.name)
    phase = 'blocked'
    return true
  }

  async function haltOnResponse(response: Response, signal: AbortSignal, head = false) {
    signal.throwIfAborted()
    if (response.status === 409) {
      // HEAD suppresses the body. The original HEAD endpoint's only 409 is account binding.
      const code = head ? 'account_mismatch' : await responseCode(response)
      signal.throwIfAborted()
      if (code === 'client_outdated') {
        clientOutdated = true
        rerun = false
        lastError = m.core_sync_update_required()
        phase = 'error'
        return true
      }
      if (cycleAccount && (code === 'account_mismatch' || code === 'account_required')) {
        gate.block(cycleAccount)
        return showBlocked()
      }
    }
    if (response.status === 503 && (head || (await responseCode(response)) === 'account_unavailable')) {
      signal.throwIfAborted()
      gate.unavailable()
      lastError = m.core_account_unavailable()
      phase = 'error'
      return true
    }
    return haltOnStatus(response.status)
  }

  async function haltOnStatus(code: number) {
    if (code === 401) {
      // A fresh sign-in can replace the session while a request is still in flight.
      if (gate.sessionGeneration !== cycleSessionGeneration) return true
      authBlocked = true
      authenticated = false
      phase = 'signed_out'
      gate.reset(true)
    } else if (code === 507) {
      uploadRetryAt = now().getTime() + 300_000
      lastError = m.core_server_space_low()
      await db.transaction('rw', db.settings, async () => {
        await assertLease()
        await db.settings.put({ key: storageRetryKey, value: uploadRetryAt })
      })
    } else return false
    return true
  }

  async function push(signal: AbortSignal) {
    const deviceId = await db.settings.get(SETTING_KEYS.deviceId)
    // Commit the claim before sending so a later edit cannot coalesce into this request.
    const selected = await db.transaction(
      'rw',
      [db.collections, db.items, db.entries, db.photos, db.movements, db.outbox, db.conflicts, db.settings],
      async () => {
        await assertLease()
        const rows = await db.outbox.toArray()
        if (signal.aborted || !rows.length) return []
        const collections = await db.collections.toArray()
        const allowed = new Map(
          collections
            .filter((c) => c.storage_mode === 'synced' && !c.removed_on_server)
            .map((c) => [c.id, c]),
        )
        const localOnlyIds = new Set(
          collections.filter((c) => c.storage_mode === 'local_only').map((c) => c.id),
        )
        const syncedItems = await syncedItemIds(db, collections)
        const conflictsByRecord = new Map<string, Set<string>>()
        for (const conflict of await db.conflicts.toArray()) {
          const key = `${conflict.entity}:${conflict.entity_id}`
          const fields = conflictsByRecord.get(key) ?? new Set<string>()
          for (const field of conflict.fields) fields.add(field)
          conflictsByRecord.set(key, fields)
        }
        const priority = { collection: 0, item: 1, entry: 2, photo: 3, movement: 4 }
        rows.sort((a, b) => priority[a.entity] - priority[b.entity] || compareQueued(a, b))
        const createHeads = new Set<string>()
        const keys = new Set<string>()
        for (const row of rows) {
          const key = `${row.entity}:${row.entity_id}`
          if (!keys.has(key) && isCreate(row)) createHeads.add(key)
          keys.add(key)
        }
        const selectedCreates = new Set<string>()
        const parentReady = (
          key: string,
          parent: { server_revision: number | null; removed_on_server?: true } | undefined,
          acknowledgedOnly: boolean,
        ) =>
          !!parent &&
          !parent.removed_on_server &&
          ((!createHeads.has(key) && parent.server_revision !== null) ||
            (!acknowledgedOnly && selectedCreates.has(key)))
        const seen = new Set<string>()
        const result: typeof rows = []
        const at = timestamp()
        for (let row of rows) {
          const key = `${row.entity}:${row.entity_id}`
          if (seen.has(key)) continue
          seen.add(key)
          const collection = allowed.get(row.collection_id)
          if (!collection || row.in_flight || row.last_error === SERVER_REMOVED_MESSAGE) continue
          const unresolved = conflictsByRecord.get(key)
          if (
            unresolved &&
            (row.op === 'purge' || Object.keys(row.fields).some((field) => unresolved.has(field)))
          )
            continue
          const missingParent =
            row.rejected_missing_parent ||
            ['Collection does not exist', 'Item does not exist'].includes(row.last_error ?? '')
          if (missingParent && row.retried_missing_parent) continue
          if (!missingParent && row.next_attempt_at && row.next_attempt_at > at) continue
          if (
            (row.entity === 'item' || row.entity === 'entry') &&
            !parentReady(`collection:${collection.id}`, collection, !!missingParent)
          )
            continue
          if (row.entity === 'item') {
            if (!syncedItems.has(row.entity_id) || (await db.items.get(row.entity_id))?.removed_on_server)
              continue
          }
          if (row.entity === 'entry' || row.entity === 'photo') {
            const record = await (row.entity === 'entry' ? db.entries : db.photos).get(row.entity_id)
            if (record?.removed_on_server) continue
            const itemId = record?.item_id ?? row.fields.item_id
            if (
              typeof itemId === 'string' &&
              (syncedItems.has(itemId)
                ? !parentReady(`item:${itemId}`, await db.items.get(itemId), !!missingParent)
                : !isAcknowledgedEntryEdit(row, record))
            )
              continue
            if (typeof itemId !== 'string' && row.op !== 'purge') continue
          }
          if (row.entity === 'movement') {
            const movement = await db.movements.get(row.entity_id)
            if (
              !movement ||
              movement.sync_state === 'local_only' ||
              movement.removed_on_server ||
              movementRooms(movement).some((id) => localOnlyIds.has(id)) ||
              !syncedItems.has(movement.item_id) ||
              !parentReady('item:' + movement.item_id, await db.items.get(movement.item_id), !!missingParent)
            )
              continue
          }
          if (missingParent) {
            await db.outbox.delete(row.id)
            row = { ...newMutationId(row), retried_missing_parent: true }
            await db.outbox.add(row)
          }
          result.push(row)
          if (isCreate(row)) selectedCreates.add(key)
          if (result.length === 200) break
        }
        if (signal.aborted) return []
        for (const row of result) await db.outbox.update(row.id, { in_flight: true, sent: true })
        return result
      },
    )
    if (!selected.length) return true
    async function releaseClaims(message?: string) {
      await db.transaction('rw', [db.outbox, db.settings], async () => {
        await assertLease()
        for (const item of selected) {
          await db.outbox.update(item.id, {
            in_flight: false,
            ...(message ? { last_error: message } : {}),
          })
        }
      })
    }
    try {
      const body = JSON.stringify({
        schema: 3,
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
      })
      const request = await db.transaction(
        'r',
        [db.collections, db.entries, db.photos, db.movements, db.outbox, db.settings],
        async () => {
          await assertLease()
          const collections = await db.collections.toArray()
          const allowed = new Set(
            collections.filter((c) => c.storage_mode === 'synced' && !c.removed_on_server).map((c) => c.id),
          )
          const current = await db.outbox.bulkGet(selected.map((row) => row.id))
          if (current.some((row) => !row?.in_flight || !allowed.has(row.collection_id))) return
          const syncedItems = await syncedItemIds(db, collections)
          const localOnlyIds = new Set(
            collections.filter((c) => c.storage_mode === 'local_only').map((c) => c.id),
          )
          for (const row of selected) {
            if (row.entity === 'collection') continue
            const record = row.entity === 'item' ? undefined : await syncTables[row.entity].get(row.entity_id)
            if (row.entity === 'movement') {
              if (
                !record ||
                record.sync_state === 'local_only' ||
                movementRooms(record as Movement).some((id) => localOnlyIds.has(id))
              )
                return
            }
            const itemId = row.entity === 'item' ? row.entity_id : (record?.item_id ?? row.fields.item_id)
            if (
              record?.removed_on_server ||
              (typeof itemId === 'string' &&
                !syncedItems.has(itemId) &&
                !isAcknowledgedEntryEdit(row, record))
            )
              return
          }
          signal.throwIfAborted()
          return startRequest('/api/sync/batch', {
            signal,
            method: 'POST',
            credentials: 'same-origin',
            headers: requestHeaders('POST', { 'Content-Type': 'application/json' }),
            body,
          })
        },
      )
      if (!request) {
        await releaseClaims()
        return true
      }
      const response = await request.response
      if (await haltOnResponse(response, signal)) {
        await releaseClaims(clientOutdated ? m.core_sync_update_required({}, storedSyncLocale) : undefined)
        return false
      }
      if (!response.ok)
        throw Object.assign(
          new Error(m.core_sync_request_failed({ status: response.status }, storedSyncLocale)),
          {
            status: response.status,
          },
        )
      const data = (await response.json()) as { results: BatchResult[] }
      const results = new Map(data.results.map((result) => [result.id, result]))
      for (const item of selected) {
        const result = results.get(item.id)
        if (!result) throw new Error(m.core_sync_ack_incomplete({}, storedSyncLocale))
        await applyResult(item, result)
      }
      return true
    } catch (error) {
      const interrupted = signal.aborted || (error instanceof DOMException && error.name === 'AbortError')
      await db.transaction('rw', [db.outbox, db.settings], async () => {
        await assertLease()
        for (const item of selected) {
          const current = await db.outbox.get(item.id)
          if (!current) continue
          if (interrupted) {
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
            last_error: syncErrorText(error),
          })
        }
      })
      if (!interrupted) {
        lastError = displaySyncError(syncErrorText(error))
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
      [
        db.collections,
        db.items,
        db.entries,
        db.photos,
        db.movements,
        db.photoBlobs,
        db.outbox,
        db.conflicts,
        db.settings,
      ],
      async () => {
        await assertLease()
        const current = await db.outbox.get(item.id)
        if (!current) return
        const table = syncTables[item.entity]
        const record = await table.get(item.entity_id)
        const collection = await db.collections.get(item.collection_id)
        const localOnly =
          collection?.storage_mode === 'local_only' ||
          (item.entity === 'movement' && record?.sync_state === 'local_only')
        const remaining = (
          await db.outbox.where('[entity+entity_id]').equals([item.entity, item.entity_id]).toArray()
        ).filter((row) => row.id !== item.id)
        const recoverLegacyDeletion = async (queuePart = current.queue_part) => {
          const server = outcome.record
          if (
            localOnly ||
            !record ||
            !('deleted_at' in record) ||
            !server ||
            outcome.server_revision === null ||
            !carriesLegacyDeletion(item, server) ||
            remaining.some((row) => row.op !== 'upsert' || carriesLegacyDeletion(row, server))
          )
            return false
          const lifecycle = deletionOperation(item.fields)
          if (
            !lifecycle ||
            lifecycle !== deletionOperation(record) ||
            lifecycle === deletionOperation(server)
          )
            return false
          const revisions = server.field_revisions
          await db.outbox.add({
            ...newMutationId(current),
            queue_part: queuePart,
            op: lifecycle,
            base_revision:
              (revisions?.deleted_at ?? 0) <= (item.base_revision ?? 0)
                ? outcome.server_revision
                : item.base_revision,
            fields: { deleted_at: record.deleted_at },
          })
          return true
        }
        if (outcome.status === 'applied' || outcome.status === 'duplicate') {
          await db.outbox.delete(item.id)
          if (item.op === 'purge') {
            await mergeRemoval({ entity: item.entity, id: item.entity_id }, record, true)
            return
          }
          if (record) {
            if (outcome.record && outcome.server_revision !== null) {
              const revision = outcome.server_revision
              const revisions = outcome.record.field_revisions ?? {}
              for (const row of remaining) {
                if (!isUnsent(row) || (row.base_revision ?? 0) >= revision) continue
                if (row.base_revision === null && isCreate(item)) {
                  await db.outbox.put({ ...row, base_revision: revision })
                  continue
                }
                const fields = Object.entries(row.fields)
                const safe = fields.filter(
                  ([field]) =>
                    (field in item.fields &&
                      (field !== 'deleted_at' || item.op !== 'upsert' || isCreate(item))) ||
                    (revisions[field] ?? 0) <= (row.base_revision ?? 0),
                )
                if (safe.length === fields.length) {
                  await db.outbox.put({ ...row, base_revision: revision })
                } else if (safe.length && row.op !== 'purge') {
                  const rebased = Object.fromEntries(safe)
                  const unrebased = Object.fromEntries(fields.filter(([field]) => !(field in rebased)))
                  const op = (patch: typeof row.fields) =>
                    row.op !== 'upsert' && 'deleted_at' in patch ? row.op : 'upsert'
                  const part = row.queue_part ?? ''
                  await db.outbox.put({
                    ...row,
                    queue_part: part + '0',
                    op: op(rebased),
                    base_revision: revision,
                    fields: rebased,
                  })
                  await db.outbox.add({
                    ...newMutationId(row),
                    queue_part: part + '1',
                    op: op(unrebased),
                    fields: unrebased,
                  })
                }
              }
            }
            const recovered = await recoverLegacyDeletion()
            const stillPending = remaining.length > 0 || recovered
            await table.put({
              ...record,
              server_revision:
                outcome.server_revision === null
                  ? null
                  : Math.max(record.server_revision ?? 0, outcome.server_revision),
              sync_state:
                localOnly || record.removed_on_server
                  ? record.sync_state
                  : (await db.conflicts
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
        if (localOnly) {
          await db.outbox.update(item.id, { in_flight: false })
          return
        }
        if (outcome.status === 'conflict' && outcome.code === 'field_conflict' && record) {
          const fields = outcome.conflicting_fields ?? []
          const serverRecord: ServerRecord = outcome.record ?? { id: item.entity_id }
          if (outcome.server_revision === null)
            throw new Error(m.core_sync_conflict_without_revision({}, storedSyncLocale))
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
          const hasRest = Object.keys(rest).length > 0 && item.op !== 'purge'
          const part = current.queue_part ?? ''
          const recovered = await recoverLegacyDeletion(hasRest ? part + '1' : current.queue_part)
          if (hasRest) {
            await db.outbox.add({
              ...newMutationId(current),
              queue_part: recovered ? part + '0' : current.queue_part,
              op: deletionOperation(rest) ?? 'upsert',
              base_revision: outcome.server_revision,
              fields: rest,
            })
          }
          await table.put({ ...record, sync_state: 'conflict' } as never)
          return
        }
        if (outcome.status === 'conflict' && outcome.code === 'sequence_taken' && item.entity === 'entry') {
          const serverNext = Number(outcome.record?.next_sequence_number ?? 1)
          if (collection && record && !record.server_revision && !current.preserve_sequence) {
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
            return
          }
        }
        if (outcome.code === 'missing_parent' && outcome.message === 'Record does not exist' && record) {
          const legacyLifecycle =
            current.base_revision === null &&
            (current.op === 'delete' || current.op === 'restore') &&
            (item.entity === 'entry' || item.entity === 'photo') &&
            record.server_revision === null
          if (legacyLifecycle) {
            await db.outbox.delete(current.id)
            await db.outbox.add(repairMissingCreate(newMutationId(current), { ...record, ...current.fields }))
            return
          }
          if (current.recreate_if_missing && current.op !== 'purge') {
            const reset = {
              ...record,
              server_revision: null,
              sync_state: 'pending',
              ...(item.entity === 'photo'
                ? {
                    server_storage_key: null,
                    stored_at: null,
                    upload_state: 'pending' as const,
                    upload_attempts: 0,
                    upload_next_attempt_at: null,
                    upload_error: null,
                  }
                : {}),
            } as const
            await table.put(reset as never)
            await db.outbox.bulkDelete([
              current.id,
              ...remaining.filter((row) => row.op !== 'purge').map((row) => row.id),
            ])
            await db.outbox.add(
              repairMissingCreate(
                {
                  ...newMutationId(current),
                  retried_missing_parent: false,
                  preserve_sequence: item.entity === 'entry' && record.server_revision !== null,
                },
                reset,
              ),
            )
            return
          }
        }
        const message =
          outcome.code === 'sequence_taken' && current.preserve_sequence
            ? 'This entry’s original sequence number is in use on the server.' // i18n-ignore: persisted outbox error.
            : (outcome.message ?? 'The server rejected this change.') // i18n-ignore: persisted outbox error.
        await db.outbox.put({
          ...current,
          in_flight: false,
          rejected_missing_parent:
            outcome.code === 'missing_parent' && outcome.message !== 'Record does not exist',
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

  async function canUpload(photoId: Id, itemId: Id, uploading = false) {
    const [photo, item, entries] = await Promise.all([
      db.photos.get(photoId),
      db.items.get(itemId),
      db.entries.where('item_id').equals(itemId).toArray(),
    ])
    if (!photo || photo.removed_on_server || !item || item.removed_on_server || item.server_revision == null)
      return false
    if (uploading && photo.upload_state !== 'uploading') return false
    const collections = await db.collections.bulkGet(entries.map((entry) => entry.collection_id))
    return (
      collections.some(
        (collection, index) =>
          collection?.storage_mode === 'synced' &&
          !collection.removed_on_server &&
          !entries[index]?.removed_on_server,
      ) && !collections.some((collection) => collection?.storage_mode === 'local_only')
    )
  }

  async function upload(photoId: Id, signal: AbortSignal) {
    const photo = await db.transaction(
      'rw',
      [db.photos, db.items, db.entries, db.collections, db.settings],
      async () => {
        await assertLease()
        const current = await db.photos.get(photoId)
        if (
          signal.aborted ||
          !current ||
          current.server_revision === null ||
          !['pending', 'error'].includes(current.upload_state) ||
          (current.upload_next_attempt_at && current.upload_next_attempt_at > timestamp()) ||
          !(await canUpload(photoId, current.item_id))
        )
          return
        await db.photos.update(photoId, { upload_state: 'uploading' })
        return current
      },
    )
    if (!photo) return true

    const url = `/api/photos/${encodeURIComponent(photoId)}`
    const updateClaim = (patch: Partial<PhotoWithUploadRetry>) =>
      db.transaction('rw', [db.photos, db.settings], async () => {
        await assertLease()
        await db.photos
          .where('id')
          .equals(photoId)
          .filter((photo) => photo.upload_state === 'uploading')
          .modify(patch)
      })
    const sendPhoto = async (kind: 'original' | 'thumbnail', init: RequestInit) => {
      const request = await db.transaction(
        'r',
        [db.photos, db.items, db.entries, db.collections, db.settings],
        async () => {
          await assertLease()
          if (!(await canUpload(photoId, photo.item_id, kind === 'original'))) return
          signal.throwIfAborted()
          return startRequest(`${url}/${kind}`, { ...init, signal, credentials: 'same-origin' })
        },
      )
      return request?.response
    }
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
      lastError ??= displaySyncError(message)
    }
    try {
      const head = await sendPhoto('original', {
        method: 'HEAD',
        cache: 'no-store',
      })
      if (!head) return true
      if (await haltOnResponse(head, signal, true)) {
        if (head.status === 507) await markFailed(storageLow, uploadRetryAt, photo.upload_attempts ?? 0)
        return false
      }
      if (head.ok && head.headers.get('ETag')?.replaceAll('"', '') === photo.sha256) {
        await markUploaded()
        return true
      }
      if (!head.ok && head.status !== 404)
        throw new Error(m.core_sync_check_photo_failed({ status: head.status }, storedSyncLocale))
      const blob = await readPhotoBlob(photo.id, options.repoDbName)
      if (!blob) throw new Error(m.core_sync_original_missing({}, storedSyncLocale))
      const put = await sendPhoto('original', {
        method: 'PUT',
        headers: requestHeaders('PUT', {
          'Content-Type': photo.mime_type,
          'X-Content-SHA256': photo.sha256,
        }),
        body: blob.original,
      })
      if (!put) return true
      if (await haltOnResponse(put, signal)) {
        if (put.status === 507) await markFailed(storageLow, uploadRetryAt, photo.upload_attempts ?? 0)
        return false
      }
      if (!put.ok) throw new Error(m.core_sync_upload_failed({ status: put.status }, storedSyncLocale))
      const result = (await put.json()) as { sha256: string; byte_size: number; server_storage_key: string }
      if (result.sha256 !== photo.sha256 || result.byte_size !== photo.byte_size)
        throw new Error(m.core_sync_checksum_mismatch({}, storedSyncLocale))
      await markUploaded(result.server_storage_key)
      if (!blob.thumbnail || signal.aborted) return true
      try {
        const thumb = await sendPhoto('thumbnail', {
          method: 'PUT',
          headers: requestHeaders('PUT', { 'Content-Type': 'image/jpeg' }),
          body: blob.thumbnail,
        })
        if (thumb && (await haltOnResponse(thumb, signal))) return false
      } catch {
        // Thumbnails are optional and can be regenerated.
      }
      return true
    } catch (error) {
      if (signal.aborted || (error instanceof DOMException && error.name === 'AbortError')) return false
      const attempts = (photo.upload_attempts ?? 0) + 1
      const delay = Math.min(300_000, 2_000 * 2 ** Math.min(attempts - 1, 8))
      await markFailed(syncErrorText(error), now().getTime() + delay, attempts)
      // A transport failure can affect the whole queue. A per-photo error lets other photos proceed.
      return !(error instanceof TypeError)
    } finally {
      await updateClaim({ upload_state: photo.upload_state })
    }
  }

  function movementRooms(movement: { from_collection_id?: unknown; to_collection_id?: unknown }) {
    return [movement.from_collection_id, movement.to_collection_id].filter(
      (id): id is Id => typeof id === 'string',
    )
  }

  async function pull(signal: AbortSignal) {
    let cursor = await db.settings.get(SETTING_KEYS.syncCursor).then((row) => Number(row?.value ?? 0))
    const schema2Cursor = Number((await db.settings.get(SETTING_KEYS.syncSchema2Cursor))?.value ?? 0)
    let more = true
    while (more && !signal.aborted) {
      await assertLease()
      signal.throwIfAborted()
      const response = await fetcher(`/api/sync/changes?cursor=${cursor}&limit=500&schema=3`, {
        credentials: 'same-origin',
        headers: dataHeaders(),
        signal,
      })
      if (await haltOnResponse(response, signal)) return false
      if (!response.ok)
        throw new Error(m.core_sync_changes_request_failed({ status: response.status }, storedSyncLocale))
      const page = (await response.json()) as {
        changes: Array<{
          seq: number
          entity: string
          id: Id
          record?: ServerRecord
          purged?: boolean
          removed?: boolean
        }>
        cursor: number
        has_more: boolean
      }
      for (const change of page.changes) {
        signal.throwIfAborted()
        // These rows were already consumed by the old client. Replaying a historical removal
        // could mark a currently synced record as removed or rewrite its pending mutations.
        if (change.seq <= schema2Cursor && change.entity !== 'movement') continue
        if (Object.hasOwn(syncTables, change.entity))
          await mergeChange({ ...change, entity: change.entity as OutboxEntity })
      }
      cursor = page.cursor
      await db.transaction('rw', db.settings, async () => {
        await assertLease()
        signal.throwIfAborted()
        await db.settings.put({ key: SETTING_KEYS.syncCursor, value: cursor })
        if (schema2Cursor && (cursor >= schema2Cursor || !page.has_more))
          await db.settings.delete(SETTING_KEYS.syncSchema2Cursor)
      })
      more = page.has_more
    }
    return !signal.aborted
  }

  /** Run inside the same transaction as the pull merge. Inspect the entire deletion scope
   * before deleting anything, including originals that an orphan-item cascade would remove. */
  async function mergeRemoval(
    change: { entity: OutboxEntity; id: Id },
    old: ((Collection | Item | Entry | Photo | Movement) & RemoteRemoval) | undefined,
    localPurge = false,
  ) {
    if (change.entity === 'collection' && (old as Collection | undefined)?.storage_mode === 'local_only')
      return

    const oldEntry = change.entity === 'entry' ? (old as (Entry & RemoteRemoval) | undefined) : undefined
    if (oldEntry && (await db.collections.get(oldEntry.collection_id))?.storage_mode === 'local_only') return

    const oldPhoto = change.entity === 'photo' ? (old as PhotoWithUploadRetry | undefined) : undefined
    const linkedItem = change.entity === 'item' ? change.id : oldPhoto?.item_id
    const linkedEntries = linkedItem ? await db.entries.where('item_id').equals(linkedItem).toArray() : []
    if (linkedEntries.length) {
      const owners = await db.collections.bulkGet(linkedEntries.map((entry) => entry.collection_id))
      if (owners.some((owner) => owner?.storage_mode === 'local_only')) return
    }
    const entries =
      change.entity === 'collection'
        ? await db.entries.where('collection_id').equals(change.id).toArray()
        : change.entity === 'item'
          ? linkedEntries
          : oldEntry
            ? [oldEntry]
            : []
    const entryIds = new Set(entries.map((entry) => entry.id))
    const itemIds: Id[] = []
    if (change.entity === 'item') itemIds.push(change.id)
    else {
      const candidates = [...new Set(entries.map((entry) => entry.item_id))]
      const linked = await db.entries.where('item_id').anyOf(candidates).toArray()
      const stillUsed = new Set(
        linked.filter((entry) => !entryIds.has(entry.id)).map((entry) => entry.item_id),
      )
      itemIds.push(...candidates.filter((id) => !stillUsed.has(id)))
    }
    const items = (await db.items.bulkGet(itemIds)).filter((item) => item !== undefined)
    const photos = oldPhoto ? [oldPhoto] : await db.photos.where('item_id').anyOf(itemIds).toArray()
    const photoIds = photos.map((photo) => photo.id)
    const keys = [
      [change.entity, change.id],
      ...entries.map((entry) => ['entry', entry.id]),
      ...itemIds.map((id) => ['item', id]),
      ...photoIds.map((id) => ['photo', id]),
    ]
    const [directRows, attributedRows, conflictCount, blobs] = await Promise.all([
      db.outbox.where('[entity+entity_id]').anyOf(keys).toArray(),
      change.entity === 'collection' ? db.outbox.where('collection_id').equals(change.id).toArray() : [],
      db.conflicts.where('[entity+entity_id]').anyOf(keys).count(),
      db.photoBlobs.where('photo_id').anyOf(photoIds).primaryKeys(),
    ])
    if (
      !localPurge &&
      directRows.some(
        (row) => row.entity === change.entity && row.entity_id === change.id && row.recreate_if_missing,
      )
    )
      return
    const retargeted = attributedRows.length
      ? await retargetSharedMutations(
          db,
          attributedRows,
          await db.collections.toArray(),
          new Set([change.id]),
        )
      : new Set<Id>()
    const rows = [...new Map([...directRows, ...attributedRows].map((row) => [row.id, row])).values()].filter(
      (row) => !retargeted.has(row.id),
    )
    const withBlob = new Set(blobs)
    const records = [old, ...entries, ...items, ...photos].filter((record) => record !== undefined)
    if (
      records.some((record) => record.server_revision == null || record.removed_on_server) ||
      rows.some((row) => row.op !== 'purge') ||
      conflictCount ||
      (!localPurge && withBlob.size > 0) ||
      photos.some(
        (photo) =>
          photo.upload_state !== 'uploaded' &&
          (withBlob.has(photo.id) || ['pending', 'uploading', 'error'].includes(photo.upload_state)),
      )
    ) {
      const retained = { removed_on_server: true, sync_state: 'error' } as const
      if (change.entity === 'collection' && old) await db.collections.update(change.id, retained)
      await db.entries.bulkUpdate(entries.map(({ id }) => ({ key: id, changes: retained })))
      await db.items.bulkUpdate(items.map(({ id }) => ({ key: id, changes: retained })))
      await db.photos.bulkUpdate(
        photos.map(({ id }) => ({
          key: id,
          changes: { ...retained, server_storage_key: null, upload_state: 'not_needed' },
        })),
      )
      await db.outbox.bulkUpdate(
        rows.map(({ id }) => ({
          key: id,
          changes: { in_flight: false, last_error: SERVER_REMOVED_MESSAGE },
        })),
      )
      return
    }

    // An orphan-item purge can arrive on an earlier page than its collection removal.
    // Leave the placements for the collection or entry removal to handle together.
    if (change.entity === 'item' && linkedEntries.length) return
    await db.entries.bulkDelete([...entryIds])
    await db.items.bulkDelete(itemIds)
    if (localPurge) {
      const movements = await db.movements.where('item_id').anyOf(itemIds).primaryKeys()
      await db.movements.bulkDelete(movements)
      await db.outbox
        .where('[entity+entity_id]')
        .anyOf(movements.map((id) => ['movement', id]))
        .delete()
    }
    await db.photos.bulkDelete(photoIds)
    await db.photoBlobs.bulkDelete(photoIds)
    await db.outbox.bulkDelete(rows.map((row) => row.id))
    if (change.entity === 'collection') await db.collections.delete(change.id)
  }

  async function mergeChange(change: {
    entity: OutboxEntity
    id: Id
    record?: ServerRecord
    purged?: boolean
    removed?: boolean
  }) {
    await db.transaction(
      'rw',
      [
        db.collections,
        db.items,
        db.entries,
        db.photos,
        db.movements,
        db.photoBlobs,
        db.outbox,
        db.conflicts,
        db.settings,
      ],
      async () => {
        await assertLease()
        const table = syncTables[change.entity]
        const old = await table.get(change.id)
        if (change.entity === 'movement') {
          if (old?.sync_state === 'local_only') return
          const roomIds = movementRooms(
            (old as Movement | undefined) ?? (change.record as Partial<Movement> | undefined) ?? {},
          )
          if ((await db.collections.bulkGet(roomIds)).some((room) => room?.storage_mode === 'local_only'))
            return
          if (change.purged || change.removed) {
            const key = [change.entity, change.id]
            const queued = db.outbox.where('[entity+entity_id]').equals(key)
            const conflicts = db.conflicts.where('[entity+entity_id]').equals(key)
            if (
              old &&
              (old.server_revision === null || (await queued.count()) || (await conflicts.count()))
            ) {
              await db.movements.update(change.id, { removed_on_server: true, sync_state: 'error' })
              await queued.modify({ in_flight: false, last_error: SERVER_REMOVED_MESSAGE })
            } else {
              await db.movements.delete(change.id)
            }
            return
          }
        }
        if (change.purged || change.removed) {
          await mergeRemoval(change, old)
          return
        }
        if (old?.removed_on_server) return
        if (!change.record) return
        if (
          old?.server_revision != null &&
          change.record.revision != null &&
          change.record.revision < old.server_revision
        )
          return
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
          if (change.entity === 'photo' && (await db.items.get(String(incoming.item_id)))?.removed_on_server)
            return
        }
        if (change.entity === 'entry') {
          const collection = await db.collections.get(collectionId)
          if (!collection || collection.storage_mode !== 'synced' || collection.removed_on_server) return
          if ((await db.items.get(String(incoming.item_id)))?.removed_on_server) return
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
          ...pending.flatMap((item) =>
            Object.keys(item.fields).filter(
              (field) =>
                field !== 'deleted_at' ||
                item.op !== 'upsert' ||
                isCreate(item) ||
                carriesLegacyDeletion(item, incoming),
            ),
          ),
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

  async function sync(signal: AbortSignal, reclaimed: boolean) {
    if (authBlocked) {
      phase = 'signed_out'
      return
    }
    if (typeof navigator !== 'undefined' && !navigator.onLine) {
      phase = 'offline'
      return
    }

    await assertLease()
    signal.throwIfAborted()
    phase = 'syncing'
    lastError = null
    cycleSessionGeneration = gate.sessionGeneration
    const access = await gate.check(fetcher, signal)
    if (showBlocked()) return
    if (access.kind !== 'ready') {
      await haltOnStatus(401)
      return
    }
    authenticated = true
    cycleAccount = access.user.id
    uploadRetryAt = await storedUploadRetryAt()
    signal.throwIfAborted()
    lastError = uploadRetryAt > now().getTime() ? m.core_server_space_low() : null
    if (needsRepair || reclaimed) {
      await db.transaction(
        'rw',
        [db.settings, db.collections, db.entries, db.photos, db.outbox],
        async () => {
          await assertLease()
          await repairSyncQueue(db)
        },
      )
      needsRepair = false
    }
    if (!(await push(signal)) || !(await pull(signal))) return

    if (uploadRetryAt <= now().getTime()) {
      const collections = await db.collections.toArray()
      const syncedItems = await syncedItemIds(db, collections)
      const photos = (await db.photos.toArray())
        .filter(
          (photo) =>
            syncedItems.has(photo.item_id) &&
            !photo.removed_on_server &&
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

  async function withLease(abort: AbortController, webLock = false) {
    const owner = createId()
    const acquisition = await db.transaction('rw', db.settings, async () => {
      const existing = await readLease()
      const at = now().getTime()
      if (abort.signal.aborted) return
      // The browser releases a document's Web Lock on unload, even if its IndexedDB
      // cleanup never runs. A newly granted lock proves that lease can be reclaimed.
      if (existing && existing.expiresAt > at && !(webLock && existing.webLock)) return
      await db.settings.put({ key: leaseKey, value: { owner, expiresAt: at + leaseDuration, webLock } })
      return { reclaimed: !!existing }
    })
    if (!acquisition) return
    leaseOwner = owner
    const heartbeat = setInterval(() => {
      if (abort.signal.aborted) return
      void db
        .transaction('rw', db.settings, async () => {
          await assertLease(owner)
          await db.settings.put({
            key: leaseKey,
            value: { owner, expiresAt: now().getTime() + leaseDuration, webLock },
          })
        })
        .catch(() => abort.abort())
    }, leaseDuration / 3)
    try {
      await sync(abort.signal, acquisition.reclaimed)
    } finally {
      clearInterval(heartbeat)
      try {
        await db.transaction('rw', db.settings, async () => {
          const current = await readLease()
          if (current?.owner === owner && current.expiresAt > now().getTime()) {
            await db.settings.delete(leaseKey)
          }
        })
      } finally {
        leaseOwner = undefined
      }
    }
  }

  async function runCycle() {
    if (clientOutdated) return
    if (showBlocked()) {
      await refreshStatus()
      return
    }
    if (running) {
      rerun = true
      return running
    }
    const abort = new AbortController()
    controller.current = abort
    running = (async () => {
      try {
        if (typeof navigator !== 'undefined' && navigator.locks) {
          await navigator.locks.request(`capture-sync:${db.name}`, { signal: abort.signal }, () =>
            withLease(abort, true),
          )
        } else await withLease(abort)
      } catch (error) {
        if (
          !abort.signal.aborted &&
          !showBlocked() &&
          !(error instanceof DOMException && error.name === 'AbortError')
        ) {
          lastError =
            error instanceof AccountRequestError ? error.message : displaySyncError(syncErrorText(error))
          phase = 'error'
        }
      } finally {
        if (phase === 'syncing') phase = lastError ? 'error' : 'idle'
        cycleAccount = undefined
        controller.current = null
        showBlocked()
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
    if (showBlocked()) return
    clientOutdated = false
    await clearBackoff(true)
    await runCycle()
  }
  const onOnline = () => {
    if (clientOutdated || gate.current.kind === 'blocked') return
    void clearBackoff(false).then(runCycle)
  }
  const onVisibility = () => {
    if (document.visibilityState === 'visible') void runCycle()
  }
  const onAuthenticated = () => {
    if (gate !== accountGate) gate.reset()
    authBlocked = false
    controller.current?.abort()
    void runCycle()
  }
  const onSignedOut = () => {
    if (gate !== accountGate) gate.reset(true)
    authBlocked = true
    authenticated = false
    lastError = null
    phase = 'signed_out'
    controller.current?.abort()
    void refreshStatus()
  }
  const onSessionChange = (event: StorageEvent) => {
    if (event.key !== sessionChangeKey || gate !== accountGate) return
    gate.reset()
    onAuthenticated()
  }
  window.addEventListener('capture:authenticated', onAuthenticated)
  window.addEventListener('capture:signed-out', onSignedOut)
  function start() {
    if (started) return
    started = true
    needsRepair = true
    window.addEventListener('online', onOnline)
    window.addEventListener('storage', onSessionChange)
    window.addEventListener('capture:authenticated', onAuthenticated)
    window.addEventListener('capture:signed-out', onSignedOut)
    document.addEventListener('visibilitychange', onVisibility)
    timer = setInterval(() => {
      if (navigator.onLine && document.visibilityState === 'visible') void runCycle()
    }, options.intervalMs ?? 30_000)
    const outboxSubscription = liveQuery(() => db.outbox.toArray()).subscribe((rows) => {
      if (!rows.length || !started || clientOutdated || gate.current.kind === 'blocked') return
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
    window.removeEventListener('storage', onSessionChange)
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
      [db.conflicts, db.collections, db.items, db.entries, db.photos, db.movements, db.outbox],
      async () => {
        const conflict = await db.conflicts.get(conflictId)
        if (!conflict) return
        const table = syncTables[conflict.entity]
        const record = (await table.get(conflict.entity_id)) as
          | ((Collection | Item | Entry | Photo | Movement) & RemoteRemoval)
          | undefined
        const collection = await db.collections.get(conflict.collection_id)
        if (record) {
          if (choice === 'server') {
            const rows = await db.outbox
              .where('[entity+entity_id]')
              .equals([conflict.entity, conflict.entity_id])
              .toArray()
            const resolved = new Set(conflict.fields)
            let pending = 0
            for (const row of rows) {
              const fields = Object.fromEntries(
                Object.entries(row.fields).filter(([field]) => !resolved.has(field)),
              )
              const cancelPurge = row.op === 'purge' && resolved.has('deleted_at')
              if (!cancelPurge && Object.keys(fields).length === Object.keys(row.fields).length) {
                pending++
                continue
              }
              if (cancelPurge || !Object.keys(fields).length) {
                await db.outbox.delete(row.id)
                continue
              }
              const adjusted = isUnsent(row) ? row : { ...newMutationId(row), retried_missing_parent: false }
              if (adjusted.id !== row.id) await db.outbox.delete(row.id)
              await db.outbox.put({
                ...adjusted,
                op: resolved.has('deleted_at') ? 'upsert' : row.op,
                fields,
              })
              pending++
            }
            const conflictsLeft = await db.conflicts
              .where('[entity+entity_id]')
              .equals([conflict.entity, conflict.entity_id])
              .count()
            await table.put({
              ...record,
              ...conflict.server_values,
              server_revision: Math.max(record.server_revision ?? 0, conflict.server_revision),
              sync_state: conflictsLeft > 1 ? 'conflict' : pending ? 'pending' : 'synced',
            } as never)
          } else {
            if (collection?.storage_mode !== 'synced') {
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
