import { Blob as NodeBlobImpl } from 'node:buffer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import Dexie from 'dexie'
import * as captureDb from '../db'
import type { Id, OutboxEntity, Photo } from '../types'
import { createRepo, getCaptureDb, queueMutation, repairSyncQueue } from '../db'
import { sha256 } from '../photos'
import { createSyncEngine as newSyncEngine, type SyncEngineOptions } from './index'
import type { PhotoUploadProgress } from './api'
import { setLocale } from '../paraglide/runtime.js'

const NodeBlob = NodeBlobImpl as unknown as typeof Blob
type ServerRecord = Record<string, unknown> & {
  id: Id
  revision: number
  field_revisions: Record<string, number>
}
type Mutation = {
  id: Id
  entity: OutboxEntity
  entity_id: Id
  collection_id: Id
  op: string
  base_revision: number | null
  fields: Record<string, unknown>
}
type Change = {
  seq: number
  entity: OutboxEntity
  id: Id
  record?: ServerRecord
  purged?: boolean
  removed?: boolean
}

class MemoryServer {
  authenticated = true
  unauthorizedBatch = false
  failAfterBatch = false
  mismatchUpload = false
  storageLow = false
  clientOutdated = false
  pageSize = 500
  batchRequests: Mutation[][] = []
  requests: Array<{ url: string; method: string; body?: unknown }> = []
  records = new Map<string, ServerRecord>()
  mutationResults = new Map<Id, Record<string, unknown>>()
  changes: Change[] = []
  stored = new Map<Id, { sha256: string; byte_size: number; key: string }>()
  collectionsWithModes = new Map<Id, 'local_only' | 'synced'>()
  pulls = 0

  key(entity: OutboxEntity, id: Id) {
    return `${entity}:${id}`
  }
  fetch = async (input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> => {
    const url = String(input)
    const method = init.method ?? 'GET'
    this.requests.push({ url, method, body: init.body })
    if (url === '/api/auth/session')
      return new Response(
        JSON.stringify({
          authenticated: this.authenticated,
          expires_at: null,
          user: this.authenticated ? { id: 'owner', name: 'Owner', is_owner: true } : null,
        }),
        {
          status: 200,
        },
      )
    if (url === '/api/auth/login' && method === 'POST') {
      this.authenticated = true
      return new Response(null, { status: 204 })
    }
    if (!this.authenticated || (this.unauthorizedBatch && url === '/api/sync/batch')) {
      if (url === '/api/sync/batch') this.authenticated = false
      return new Response(JSON.stringify({ detail: 'auth_required' }), { status: 401 })
    }
    if (url === '/api/sync/batch') {
      if (this.clientOutdated)
        return new Response(JSON.stringify({ code: 'client_outdated' }), { status: 409 })
      const payload = JSON.parse(String(init.body)) as { mutations: Mutation[] }
      this.batchRequests.push(payload.mutations)
      const results: Record<string, unknown>[] = []
      for (const mutation of payload.mutations) results.push(this.applyMutation(mutation))
      if (this.failAfterBatch) {
        this.failAfterBatch = false
        throw new TypeError('Connection lost after server commit')
      }
      return new Response(JSON.stringify({ results, cursor: this.changes.at(-1)?.seq ?? 0 }), { status: 200 })
    }
    if (url.startsWith('/api/sync/changes')) {
      this.pulls++
      const cursor = Number(new URL(url, 'https://capture.test').searchParams.get('cursor') ?? 0)
      const changes = this.changes.filter((change) => change.seq > cursor).slice(0, this.pageSize)
      const hasMore = this.changes.some((change) => change.seq > (changes.at(-1)?.seq ?? cursor))
      const nextCursor = hasMore ? (changes.at(-1)?.seq ?? cursor) : (this.changes.at(-1)?.seq ?? cursor)
      return new Response(JSON.stringify({ changes, cursor: nextCursor, has_more: hasMore }), { status: 200 })
    }
    const photoMatch = url.match(/^\/api\/photos\/([^/]+)\/(original|thumbnail)$/)
    if (photoMatch) {
      const photoId = decodeURIComponent(photoMatch[1]!)
      const kind = photoMatch[2]
      const record = this.records.get(this.key('photo', photoId))
      if (method === 'HEAD' && kind === 'original') {
        const stored = this.stored.get(photoId)
        return stored
          ? new Response(null, { status: 200, headers: { ETag: stored.sha256 } })
          : new Response(null, { status: 404 })
      }
      if (method === 'PUT' && kind === 'original') {
        if (this.storageLow)
          return new Response(JSON.stringify({ detail: 'server_storage_low' }), { status: 507 })
        if (!record) return new Response(null, { status: 409 })
        const blob = init.body as Blob
        const digest = await sha256(blob)
        const expectedHeader = new Headers(init.headers).get('X-Content-SHA256')
        if (expectedHeader !== record.sha256 || digest !== expectedHeader || blob.size !== record.byte_size)
          return new Response(JSON.stringify({ detail: 'checksum_mismatch' }), { status: 422 })
        if (!this.stored.has(photoId))
          this.stored.set(photoId, { sha256: digest, byte_size: blob.size, key: `media/${photoId}` })
        const stored = this.stored.get(photoId)!
        return new Response(
          JSON.stringify({
            photo_id: photoId,
            sha256: this.mismatchUpload ? 'bad-hash' : stored.sha256,
            byte_size: this.mismatchUpload ? stored.byte_size + 1 : stored.byte_size,
            server_storage_key: stored.key,
          }),
          { status: 201 },
        )
      }
      if (method === 'PUT' && kind === 'thumbnail') return new Response(null, { status: 201 })
    }
    return new Response(JSON.stringify({ detail: 'not_found' }), { status: 404 })
  }

  applyMutation(mutation: Mutation): Record<string, unknown> {
    const duplicate = this.mutationResults.get(mutation.id)
    if (duplicate) return { ...duplicate, status: 'duplicate' }
    const key = this.key(mutation.entity, mutation.entity_id)
    const existing = this.records.get(key)
    if (!existing && (mutation.op !== 'upsert' || mutation.base_revision !== null)) {
      const rejected = {
        id: mutation.id,
        status: 'rejected',
        code: 'missing_parent',
        message: 'Record does not exist',
        server_revision: null,
      }
      this.mutationResults.set(mutation.id, rejected)
      return rejected
    }
    if (existing && mutation.base_revision === null) {
      const rejected = {
        id: mutation.id,
        status: 'rejected',
        code: 'invalid_field',
        message: 'base_revision is required for updates',
        server_revision: existing.revision,
      }
      this.mutationResults.set(mutation.id, rejected)
      return rejected
    }
    const fields = { ...mutation.fields }
    if (existing && mutation.op === 'upsert') delete fields.deleted_at
    if (existing && mutation.op === 'delete')
      fields.deleted_at = new Date(clock().getTime() + (this.changes.length + 1) * 1_000).toISOString()
    if (existing && mutation.op === 'restore') fields.deleted_at = null
    if (mutation.entity === 'entry' && !existing) {
      const sibling = [...this.records.values()].find(
        (row) =>
          row.collection_id === mutation.collection_id &&
          row.sequence_number === mutation.fields.sequence_number,
      )
      if (sibling) {
        const collection = this.records.get(this.key('collection', mutation.collection_id))!
        const result = {
          id: mutation.id,
          status: 'conflict',
          code: 'sequence_taken',
          server_revision: collection.revision,
          record: structuredClone(collection),
        }
        this.mutationResults.set(mutation.id, result)
        return result
      }
    }
    if (mutation.entity !== 'collection' && !this.records.has(this.key('collection', mutation.collection_id)))
      return {
        id: mutation.id,
        status: 'rejected',
        code: 'missing_parent',
        message: 'Missing collection.',
        server_revision: 0,
      }
    const conflicting = existing
      ? Object.keys(fields).filter(
          (field) =>
            (existing.field_revisions[field] ?? 0) > (mutation.base_revision ?? 0) &&
            existing[field] !== fields[field],
        )
      : []
    if (conflicting.length) {
      const result = {
        id: mutation.id,
        status: 'conflict',
        code: 'field_conflict',
        conflicting_fields: conflicting,
        server_revision: existing!.revision,
        record: structuredClone(existing!),
      }
      this.mutationResults.set(mutation.id, result)
      return result
    }
    const revision = (existing?.revision ?? 0) + 1
    if (mutation.entity === 'collection' && typeof fields.next_sequence_number === 'number') {
      fields.next_sequence_number = Math.max(
        Number(existing?.next_sequence_number ?? 1),
        fields.next_sequence_number,
      )
    }
    const fieldRevisions = { ...existing?.field_revisions }
    for (const [field, value] of Object.entries(fields)) {
      if (
        [
          'id',
          'collection_id',
          'entry_id',
          'sequence_number',
          'sha256',
          'byte_size',
          'crc32',
          'mime_type',
          'revision',
          'server_revision',
          'sync_state',
          'upload_state',
          'server_storage_key',
        ].includes(field) &&
        existing
      )
        continue
      if (!existing || existing[field] !== value) fieldRevisions[field] = revision
    }
    const record = {
      ...existing,
      ...fields,
      id: mutation.entity_id,
      revision,
      field_revisions: fieldRevisions,
    } as ServerRecord
    this.records.set(key, record)
    if (mutation.entity === 'collection') this.collectionsWithModes.set(mutation.collection_id, 'synced')
    this.changes.push({
      seq: this.changes.length + 1,
      entity: mutation.entity,
      id: mutation.entity_id,
      record: structuredClone(record),
    })
    const result = {
      id: mutation.id,
      status: 'applied',
      server_revision: revision,
      record: structuredClone(record),
    }
    this.mutationResults.set(mutation.id, result)
    return result
  }

  externalUpdate(entity: OutboxEntity, id: Id, fields: Record<string, unknown>) {
    const row = this.records.get(this.key(entity, id))!
    const revision = row.revision + 1
    const fieldRevisions = { ...row.field_revisions }
    for (const field of Object.keys(fields)) fieldRevisions[field] = revision
    const updated = { ...row, ...fields, revision, field_revisions: fieldRevisions }
    this.records.set(this.key(entity, id), updated)
    this.changes.push({ seq: this.changes.length + 1, entity, id, record: structuredClone(updated) })
  }

  pushChange(change: Omit<Change, 'seq'>) {
    this.changes.push({ ...change, seq: this.changes.length + 1 })
  }
}

class TestUpload {
  private controller = new AbortController()
  readonly upload = {
    onprogress: null as ((event: { loaded: number }) => void) | null,
    onload: null as (() => void) | null,
  }
  readonly headers = new Headers()
  url = ''
  method = ''
  body!: Blob
  onload: (() => void) | null = null
  onerror: (() => void) | null = null
  onabort: (() => void) | null = null
  status = 0
  statusText = ''
  responseText = ''
  getAllResponseHeaders = () => ''
  get aborted() {
    return this.controller.signal.aborted
  }

  constructor(private onSend: (xhr: TestUpload) => void) {}

  open(method: string, url: string) {
    this.method = method
    this.url = url
  }

  setRequestHeader(name: string, value: string) {
    this.headers.set(name, value)
  }

  send(body: Blob) {
    this.body = body
    this.onSend(this)
  }

  abort() {
    this.controller.abort()
    this.onabort?.()
  }

  async reply(fetcher: typeof fetch) {
    try {
      const response = await fetcher(this.url, {
        method: this.method,
        headers: this.headers,
        body: this.body,
        signal: this.controller.signal,
      })
      this.responseText = await response.text()
      this.status = response.status
      this.statusText = response.statusText
      this.getAllResponseHeaders = () =>
        Array.from(response.headers, ([name, value]) => `${name}: ${value}\r\n`).join('')
      this.onload?.()
    } catch {
      this.onerror?.()
    }
  }
}

function xhrFactory(onSend: (xhr: TestUpload) => void) {
  return () => new TestUpload(onSend) as unknown as XMLHttpRequest
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => (resolve = done))
  return { promise, resolve }
}

const engines: ReturnType<typeof newSyncEngine>[] = []

function createSyncEngine(options: SyncEngineOptions) {
  const engine = newSyncEngine(options)
  engines.push(engine)
  return engine
}

let testIndex = 0
const dbName = () => `sync-acceptance-${++testIndex}`
const fixedNow = { value: new Date('2026-11-08T12:00:00.000Z') }
const clock = () => new Date(fixedNow.value)

function makeRepo(name: string) {
  return createRepo({
    databaseName: name,
    now: clock,
    imageProcessor: async () => ({ width: 4, height: 3, thumbnail: new NodeBlob(['thumb']) as Blob }),
  })
}

function makeEngine(name: string, server: MemoryServer, options?: SyncEngineOptions) {
  return createSyncEngine({
    repoDbName: name,
    fetch: server.fetch,
    xhrFactory: xhrFactory((xhr) => void xhr.reply(server.fetch)),
    now: clock,
    ...options,
  })
}

async function syncedEntry(server: MemoryServer) {
  const name = dbName()
  const repo = makeRepo(name)
  const collection = await repo.createCollection({ name: 'Room', storage_mode: 'synced' })
  const entry = await repo.createEntry(collection.id, { notes: 'initial', title: 'Box' })
  const engine = makeEngine(name, server)
  await engine.syncNow()
  return { name, repo, collection, entry, engine, db: getCaptureDb(name) }
}

async function addPhoto(repo: ReturnType<typeof makeRepo>, entryId: Id) {
  return (
    await repo.addPhotos(entryId, [
      { blob: new NodeBlob(['photo-bytes'], { type: 'image/jpeg' }) as Blob, source: 'photo_library' },
    ])
  )[0]!
}

async function waitFor(predicate: () => Promise<boolean>, message = 'Timed out waiting for sync') {
  for (let tries = 0; tries < 100; tries++) {
    if (await predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error(message)
}

afterEach(() => {
  for (const engine of engines.splice(0)) engine.stop()
  fixedNow.value = new Date('2026-11-08T12:00:00.000Z')
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('sync acceptance against an in-memory API server', () => {
  it('sends schema 3 and keeps the outbox when the server requires an app update', async () => {
    const server = new MemoryServer()
    const fixture = await syncedEntry(server)
    expect(server.batchRequests[0]?.map((mutation) => mutation.entity)).toEqual([
      'collection',
      'item',
      'entry',
    ])
    await fixture.repo.updateEntry(fixture.entry.id, { quantity: '3' })
    server.clientOutdated = true
    let lastError: string | null = null
    const unsubscribe = fixture.engine.status.subscribe((value) => {
      lastError = value.last_error
    })
    await fixture.engine.syncNow()
    const batch = server.requests.filter((request) => request.url === '/api/sync/batch').at(-1)!
    expect(JSON.parse(String(batch.body)).schema).toBe(3)
    expect(
      server.requests.some(
        (request) => request.url.includes('/api/sync/changes?') && request.url.includes('schema=3'),
      ),
    ).toBe(true)
    expect(
      await fixture.db.outbox.where('[entity+entity_id]').equals(['entry', fixture.entry.id]).count(),
    ).toBe(1)
    expect(lastError).toBe('Update the app to keep syncing.')
    if (typeof unsubscribe === 'function') unsubscribe()
    else unsubscribe.unsubscribe()
    await fixture.db.delete()
  })

  it('keeps local collection data when a removed change arrives after switching to Local Only', async () => {
    const server = new MemoryServer()
    const fixture = await syncedEntry(server)
    await fixture.repo.setStorageMode(fixture.collection.id, 'local_only', { consentToUploadExisting: false })
    server.pushChange({ entity: 'collection', id: fixture.collection.id, removed: true })
    await fixture.engine.syncNow()
    expect(await fixture.db.collections.get(fixture.collection.id)).toMatchObject({
      storage_mode: 'local_only',
    })
    expect(await fixture.db.entries.get(fixture.entry.id)).toBeDefined()
    expect(await fixture.db.items.get(fixture.entry.id)).toBeDefined()
    await fixture.db.delete()
  })

  it('uses the current storage mode after hashing a new photo', async () => {
    const server = new MemoryServer()
    const { db, repo, collection, entry, engine } = await syncedEntry(server)
    const blob = new NodeBlob(['private'], { type: 'image/jpeg' })
    let entered!: () => void
    let release!: () => void
    const started = new Promise<void>((resolve) => (entered = resolve))
    const gate = new Promise<void>((resolve) => (release = resolve))
    const read = blob.arrayBuffer.bind(blob)
    vi.spyOn(blob, 'arrayBuffer').mockImplementationOnce(async () => {
      entered()
      await gate
      return read()
    })
    const capture = repo.addPhotos(entry.id, [{ blob: blob as Blob, source: 'photo_library' }])
    await started
    await repo.setStorageMode(collection.id, 'local_only', { consentToUploadExisting: false })
    release()
    const [photo] = await capture
    expect(await db.collections.get(collection.id)).toMatchObject({ storage_mode: 'local_only' })
    expect(await db.photos.get(photo!.id)).toMatchObject({ upload_state: 'not_needed' })
    expect(await db.outbox.count()).toBe(0)
    const offset = server.requests.length
    await engine.syncNow()
    expect(JSON.stringify(server.requests.slice(offset))).not.toContain(photo!.id)
    await db.delete()
  })

  it.each(['archiveCollection', 'unarchiveCollection'] as const)(
    '%s keeps a concurrent Local Only switch',
    async (operation) => {
      const { db, repo, collection } = await syncedEntry(new MemoryServer())
      if (operation === 'unarchiveCollection') await repo.archiveCollection(collection.id)
      // The mode write is queued before an archive that first does a standalone lookup.
      await Promise.all([
        repo[operation](collection.id),
        repo.setStorageMode(collection.id, 'local_only', { consentToUploadExisting: false }),
      ])
      expect(await db.collections.get(collection.id)).toMatchObject({ storage_mode: 'local_only' })
      expect(await db.outbox.count()).toBe(0)
      await db.delete()
    },
  )

  it.each(['collection', 'entry', 'item', 'photo'] as const)(
    'preserves unsynced edits and originals through a remote %s removal',
    async (entity) => {
      const server = new MemoryServer()
      const { name, db, repo, collection, entry, engine } = await syncedEntry(server)
      const photo = await addPhoto(repo, entry.id)
      const kept = await repo.createEntry(collection.id)
      await repo.updateEntry(entry.id, { quantity: '27' })
      const id = entity === 'collection' ? collection.id : entity === 'photo' ? photo.id : entry.id
      // Leave local metadata queued and model a previously acknowledged photo whose bytes never arrived.
      await db.outbox.where('collection_id').equals(collection.id).modify({
        next_attempt_at: '2026-11-09T00:00:00.000Z',
      })
      await db.photos.update(photo.id, { server_revision: 1, upload_state: 'pending' })
      if (entity === 'collection') {
        // Server-copy removal logs orphan photo and item purges before the collection marker.
        server.pushChange({ entity: 'photo', id: photo.id, purged: true })
        server.pushChange({ entity: 'item', id: entry.item_id, purged: true })
      }
      server.pushChange({ entity, id, ...(entity === 'collection' ? { removed: true } : { purged: true }) })
      await engine.runScheduledCycle()
      expect(await (await repo.getPhotoBlob(photo.id))?.original.text()).toBe('photo-bytes')
      expect((await repo.getEntry(entry.id))?.display_sync_state).toBe('error')
      expect(await db.entries.get(entry.id)).toMatchObject({ quantity: '27' })
      expect(await db.entries.get(kept.id)).toBeDefined()
      const offset = server.requests.length
      await makeEngine(name, server).syncNow()
      expect(
        server.requests
          .slice(offset)
          .some(({ url, body }) => url.includes(photo.id) || JSON.stringify(body ?? '').includes(id)),
      ).toBe(false)
      await db.delete()
    },
  )

  it('keeps sent creates across Local Only and rebases the consented replacements on acknowledgment', async () => {
    const server = new MemoryServer()
    const name = dbName()
    const repo = makeRepo(name)
    const db = getCaptureDb(name)
    const collection = await repo.createCollection({ name: 'Room', storage_mode: 'synced' })
    const entry = await repo.createEntry(collection.id)
    const photo = await addPhoto(repo, entry.id)
    const batch = holdBatch(server)
    const engine = makeEngine(name, server)
    const syncing = engine.syncNow()
    await batch.entered
    try {
      await repo.setStorageMode(collection.id, 'local_only', { consentToUploadExisting: false })
      await repo.updateEntry(entry.id, { quantity: '12' })
      await repo.setStorageMode(collection.id, 'synced', { consentToUploadExisting: true })
    } finally {
      batch.release()
      await syncing
    }
    await engine.syncNow()
    expect(server.records.get(server.key('entry', entry.id))?.quantity).toBe('12')
    expect(await db.outbox.count()).toBe(0)
    expect(server.stored.has(photo.id)).toBe(true)
    await db.delete()
  })

  it.each(['delete', 'restore'] as const)('corrects a legacy sent upsert that lost its %s', async (op) => {
    const server = new MemoryServer()
    const { repo, db, entry, engine } = await syncedEntry(server)
    if (op === 'restore') {
      await repo.deleteEntry(entry.id)
      await engine.syncNow()
      await repo.restoreEntry(entry.id)
    } else await repo.deleteEntry(entry.id)
    const row = (await db.outbox.where('[entity+entity_id]').equals(['entry', entry.id]).first())!
    const legacy = { ...row, op: 'upsert' as const, sent: true }
    expect(server.applyMutation(legacy)).toMatchObject({ status: 'applied' })
    await db.outbox.put(legacy)
    await engine.syncNow()
    const beforeCorrection = server.batchRequests.length
    await engine.syncNow()
    expect(server.batchRequests.slice(beforeCorrection).flat()).toContainEqual(
      expect.objectContaining({ entity_id: entry.id, op, id: expect.not.stringMatching(row.id) }),
    )
    expect(server.records.get(server.key('entry', entry.id))?.deleted_at).toEqual(
      op === 'delete' ? expect.any(String) : null,
    )
    expect(await db.outbox.count()).toBe(0)
    await db.delete()
  })

  it.each(['ordinary full record', 'legacy restore'] as const)(
    'handles a concurrent server deletion after queuing %s',
    async (kind) => {
      const server = new MemoryServer()
      const { db, repo, entry, engine } = await syncedEntry(server)
      if (kind === 'legacy restore') {
        await repo.deleteEntry(entry.id)
        await engine.syncNow()
        await repo.restoreEntry(entry.id)
      } else await repo.updateEntry(entry.id, { quantity: '9' })
      const row = (await db.outbox.where('[entity+entity_id]').equals(['entry', entry.id]).first())!
      await db.outbox.update(row.id, {
        op: 'upsert',
        sent: true,
        ...(kind === 'ordinary full record'
          ? { fields: { ...(await db.entries.get(entry.id)), ...row.fields, deleted_at: null } }
          : {}),
      })
      server.externalUpdate('entry', entry.id, { deleted_at: '2026-11-08T13:00:00.000Z' })

      await engine.syncNow()
      await engine.syncNow()
      expect(server.records.get(server.key('entry', entry.id))?.deleted_at).toBe('2026-11-08T13:00:00.000Z')
      expect((await db.conflicts.toArray()).flatMap((conflict) => conflict.fields)).toEqual(
        kind === 'legacy restore' ? ['deleted_at'] : [],
      )
      expect(await db.outbox.count()).toBe(0)
      await db.delete()
    },
  )

  it('waits for unacknowledged parents and replaces an id with a stored missing_parent rejection', async () => {
    const server = new MemoryServer()
    const name = dbName()
    const repo = makeRepo(name)
    const db = getCaptureDb(name)
    const collection = await repo.createCollection({ name: 'Room', storage_mode: 'synced' })
    const entry = await repo.createEntry(collection.id)
    const photo = await addPhoto(repo, entry.id)
    const rows = await db.outbox.toArray()
    const parent = rows.find((row) => row.entity === 'collection')!
    const child = rows.find((row) => row.entity === 'entry')!
    const rejection = {
      id: child.id,
      status: 'rejected',
      code: 'missing_parent',
      message: 'Collection does not exist',
      server_revision: null,
    }
    server.mutationResults.set(child.id, rejection)
    await db.outbox.update(child.id, { sent: true, attempts: 1, last_error: rejection.message })
    await db.outbox.update(parent.id, { next_attempt_at: '2026-11-09T00:00:00.000Z' })
    const engine = makeEngine(name, server)
    await engine.runScheduledCycle()
    expect(server.batchRequests).toEqual([])
    await engine.syncNow()
    expect(server.batchRequests[0]?.map((mutation) => mutation.entity)).toEqual([
      'collection',
      'item',
      'photo',
    ])
    await engine.syncNow()
    expect(server.records.has(server.key('entry', entry.id))).toBe(true)
    expect(server.batchRequests.flat().some((mutation) => mutation.id === child.id)).toBe(false)
    expect(await db.outbox.count()).toBe(0)
    expect(server.stored.has(photo.id)).toBe(true)
    await db.delete()
  })

  it('rebases a follow-up delete separately from an unrelated conflicting field', async () => {
    const server = new MemoryServer()
    const { name, db, repo, entry } = await syncedEntry(server)
    await repo.deleteEntry(entry.id)
    await makeEngine(name, server).syncNow()
    await repo.restoreEntry(entry.id)
    const fetch = server.fetch
    let entered!: () => void
    let release!: () => void
    const reached = new Promise<void>((resolve) => (entered = resolve))
    const gate = new Promise<void>((resolve) => (release = resolve))
    let hold = true
    server.fetch = async (input, init) => {
      if (hold && String(input) === '/api/sync/batch') {
        hold = false
        entered()
        await gate
      }
      return fetch(input, init)
    }
    const engine = makeEngine(name, server)
    const syncing = engine.syncNow()
    await reached
    try {
      await repo.deleteEntry(entry.id)
      await repo.updateEntry(entry.id, { quantity: '9' })
      server.externalUpdate('entry', entry.id, { quantity: '6' })
    } finally {
      release()
      await syncing
    }
    await engine.syncNow()
    await engine.syncNow()
    expect(server.records.get(server.key('entry', entry.id))?.deleted_at).toEqual(expect.any(String))
    expect((await db.conflicts.toArray()).flatMap((conflict) => conflict.fields)).toEqual(['quantity'])
    await db.delete()
  })

  it('leaves an ordinary legacy full-record update with deleted_at null as an upsert', async () => {
    const { db, repo, entry } = await syncedEntry(new MemoryServer())
    await repo.updateEntry(entry.id, { quantity: '9' })
    const row = (await db.outbox.where('[entity+entity_id]').equals(['entry', entry.id]).first())!
    await db.outbox.update(row.id, {
      fields: { ...(await db.entries.get(entry.id)), ...row.fields, deleted_at: null },
    })
    await repairSyncQueue(db)
    expect(await db.outbox.get(row.id)).toMatchObject({ op: 'upsert' })
    await db.delete()
  })

  it('keeps a second tab without Web Locks from recovering a live upload', async () => {
    expect(navigator.locks).toBeUndefined()
    const server = new MemoryServer()
    const { name, db, repo, entry } = await syncedEntry(server)
    const photo = await addPhoto(repo, entry.id)
    let release!: () => void
    let entered!: () => void
    const reached = new Promise<void>((resolve) => (entered = resolve))
    const gate = new Promise<void>((resolve) => (release = resolve))
    const engine = createSyncEngine({
      repoDbName: name,
      now: clock,
      fetch: server.fetch,
      xhrFactory: xhrFactory((xhr) => {
        if (xhr.url === '/api/photos/' + photo.id + '/original') {
          entered()
          void gate.then(() => xhr.reply(server.fetch))
        } else void xhr.reply(server.fetch)
      }),
    })
    const first = engine.syncNow()
    await reached
    const second = makeEngine(name, server)
    try {
      const offset = server.requests.length
      second.start()
      await second.runScheduledCycle()
      expect(server.requests.slice(offset)).toEqual([])
      expect(await db.photos.get(photo.id)).toMatchObject({ upload_state: 'uploading' })
    } finally {
      second.stop()
      release()
      await first
    }
    expect(
      server.requests.filter(({ method, url }) => method === 'PUT' && url.endsWith('/original')),
    ).toHaveLength(1)
    expect(await db.photos.get(photo.id)).toMatchObject({ upload_state: 'uploaded' })
    await db.delete()
  })

  it('reclaims only expired claims and verifies a previously stored original by hash', async () => {
    const server = new MemoryServer()
    const { name, db, repo, entry, engine } = await syncedEntry(server)
    const photo = await addPhoto(repo, entry.id)
    await engine.syncNow()
    await repo.updateEntry(entry.id, { quantity: '14' })
    const row = (await db.outbox.where('[entity+entity_id]').equals(['entry', entry.id]).first())!
    await db.outbox.update(row.id, { sent: true, in_flight: true })
    await db.photos.update(photo.id, { upload_state: 'uploading' })
    await db.settings.put({
      key: 'sync_cycle_lease',
      value: { owner: 'closed-tab', expiresAt: clock().getTime() + 1000 },
    })
    const runner = makeEngine(name, server)
    const offset = server.requests.length
    await runner.runScheduledCycle()
    expect(server.requests.slice(offset)).toEqual([])
    expect(await db.outbox.get(row.id)).toMatchObject({ in_flight: true })
    expect(await db.photos.get(photo.id)).toMatchObject({ upload_state: 'uploading' })
    fixedNow.value = new Date(clock().getTime() + 1001)
    await runner.runScheduledCycle()
    expect(server.batchRequests.at(-1)).toContainEqual(expect.objectContaining({ id: row.id }))
    expect(await db.outbox.get(row.id)).toBeUndefined()
    expect(await db.photos.get(photo.id)).toMatchObject({ upload_state: 'uploaded' })
    expect(server.requests.slice(offset).filter(({ url }) => url.includes(photo.id))).toEqual([
      expect.objectContaining({ method: 'HEAD' }),
    ])
    await db.delete()
  })

  it.each([true, false])(
    'takes over an unexpired lease only when its Web Lock was released (%s)',
    async (webLock) => {
      const server = new MemoryServer()
      const { name, db, repo, entry } = await syncedEntry(server)
      await repo.updateEntry(entry.id, { quantity: '14' })
      const row = (await db.outbox.where('[entity+entity_id]').equals(['entry', entry.id]).first())!
      await db.outbox.update(row.id, { sent: true, in_flight: true })
      const expiresAt = clock().getTime() + 30_000
      await db.settings.put({
        key: 'sync_cycle_lease',
        value: { owner: 'previous-document', expiresAt, ...(webLock ? { webLock } : {}) },
      })
      // The browser has already granted the next document the exclusive lock.
      const request = vi.fn(async (_name: string, _opts: LockOptions, run: () => Promise<void>) => run())
      vi.stubGlobal('navigator', { onLine: true, locks: { request } })
      const runner = makeEngine(name, server)
      const offset = server.requests.length
      try {
        await runner.runScheduledCycle()
        expect(request).toHaveBeenCalledWith(`capture-sync:${name}`, expect.anything(), expect.any(Function))
        if (!webLock) {
          expect(server.requests.slice(offset)).toEqual([])
          expect(await db.outbox.get(row.id)).toMatchObject({ in_flight: true })
          fixedNow.value = new Date(expiresAt + 1)
          await runner.runScheduledCycle()
        }
        expect(server.batchRequests.at(-1)).toContainEqual(expect.objectContaining({ id: row.id }))
        expect(await db.outbox.get(row.id)).toBeUndefined()
      } finally {
        await db.delete()
      }
    },
  )

  it('fences a suspended tab when it returns after another tab reclaims the upload', async () => {
    const server = new MemoryServer()
    const { name, db, repo, entry } = await syncedEntry(server)
    const photo = await addPhoto(repo, entry.id)
    const url = '/api/photos/' + photo.id + '/original'
    const tab = () => {
      let reached!: () => void
      let release!: () => void
      const entered = new Promise<void>((resolve) => (reached = resolve))
      const gate = new Promise<void>((resolve) => (release = resolve))
      const engine = makeEngine(name, server, {
        fetch: async (input, init) => {
          if (String(input) === url && init?.method === 'HEAD') {
            reached()
            await gate
          }
          return server.fetch(input, init)
        },
      })
      return { engine, entered, release }
    }
    const first = tab()
    const second = tab()
    const oldCycle = first.engine.syncNow()
    await first.entered
    fixedNow.value = new Date(clock().getTime() + 60_000)
    const newCycle = second.engine.runScheduledCycle()
    try {
      await second.entered
      first.release()
      await oldCycle
      expect(await db.photos.get(photo.id)).toMatchObject({ upload_state: 'uploading' })
      expect(server.requests.filter((request) => request.url === url && request.method === 'PUT')).toEqual([])
    } finally {
      first.release()
      second.release()
      await Promise.all([oldCycle, newCycle])
    }
    expect(await db.photos.get(photo.id)).toMatchObject({ upload_state: 'uploaded' })
    expect(server.requests.filter((request) => request.url === url && request.method === 'PUT')).toHaveLength(
      1,
    )
    await db.delete()
  })

  it('removes an acknowledged, backed-up photo when its own purge comes back in the pull', async () => {
    const server = new MemoryServer()
    const { db, repo, collection, entry, engine } = await syncedEntry(server)
    const photo = await addPhoto(repo, entry.id)
    await engine.syncNow()
    await repo.deletePhoto(photo.id)
    await engine.syncNow()
    const deleted = (await db.photos.get(photo.id))!
    await db.transaction('rw', db.outbox, () =>
      queueMutation(db, collection, 'photo', deleted, 'purge', {}, clock().toISOString()),
    )
    const apply = server.applyMutation.bind(server)
    vi.spyOn(server, 'applyMutation').mockImplementation((mutation) => {
      if (mutation.op !== 'purge') return apply(mutation)
      server.pushChange({ entity: 'photo', id: photo.id, purged: true })
      return { id: mutation.id, status: 'applied', server_revision: null, record: null }
    })
    await engine.syncNow()
    expect(await db.photos.get(photo.id)).toBeUndefined()
    expect(await repo.getPhotoBlob(photo.id)).toBeUndefined()
    await db.delete()
  })

  it('protects an unbacked original even with no upload or metadata change queued', async () => {
    const server = new MemoryServer()
    const { db, repo, entry, engine } = await syncedEntry(server)
    const photo = await addPhoto(repo, entry.id)
    await engine.syncNow()
    server.stored.delete(photo.id)
    await db.photos.update(photo.id, { upload_state: 'not_needed' })
    server.pushChange({ entity: 'photo', id: photo.id, purged: true })
    await engine.runScheduledCycle()
    expect((await repo.getEntry(entry.id))?.display_sync_state).toBe('error')
    expect(await (await repo.getPhotoBlob(photo.id))?.original.text()).toBe('photo-bytes')
    await db.delete()
  })

  it('preserves a removed placement without pausing its surviving shared item', async () => {
    const server = new MemoryServer()
    const { name, db, repo, collection, entry, engine } = await syncedEntry(server)
    const other = await repo.createCollection({ name: 'Other', storage_mode: 'synced' })
    const placements = await repo.importEntries(other.id, [entry.id])
    await engine.syncNow()
    await repo.updateEntry(entry.id, { quantity: '19' })
    await db.outbox.where('[entity+entity_id]').equals(['entry', entry.id]).modify({
      next_attempt_at: '2026-11-09T00:00:00.000Z',
    })
    server.pushChange({ entity: 'collection', id: collection.id, removed: true })
    await engine.runScheduledCycle()
    expect(await db.collections.get(collection.id)).toMatchObject({
      storage_mode: 'synced',
      sync_state: 'error',
    })
    expect(await db.entries.get(entry.id)).toMatchObject({ quantity: '19' })
    expect(await db.entries.get(placements.created[0]!.id)).toBeDefined()
    const photo = await addPhoto(repo, placements.created[0]!.id)
    await makeEngine(name, server).syncNow()
    expect(server.stored.has(photo.id)).toBe(true)
    await db.delete()
  })

  it('keeps a backed-up original when a later page keeps the removed collection on this device', async () => {
    const server = new MemoryServer()
    const { db, repo, collection, entry, engine } = await syncedEntry(server)
    const photo = await addPhoto(repo, entry.id)
    await engine.syncNow()
    expect(await db.photos.get(photo.id)).toMatchObject({ upload_state: 'uploaded' })
    await repo.updateCollection(collection.id, { description: 'Pending local edit' })
    await db.outbox.where('collection_id').equals(collection.id).modify({
      next_attempt_at: '2026-11-09T00:00:00.000Z',
    })
    server.pageSize = 1
    server.pushChange({ entity: 'photo', id: photo.id, purged: true })
    server.pushChange({ entity: 'item', id: entry.item_id, purged: true })
    server.pushChange({ entity: 'collection', id: collection.id, removed: true })

    await engine.runScheduledCycle()

    expect(await db.collections.get(collection.id)).toMatchObject({
      removed_on_server: true,
      description: 'Pending local edit',
    })
    expect(await db.entries.get(entry.id)).toBeDefined()
    expect(await db.photos.get(photo.id)).toBeDefined()
    expect(await (await repo.getPhotoBlob(photo.id))?.original.text()).toBe('photo-bytes')
    await db.delete()
  })

  it.each([true, false])(
    'recreates a removed copy after Local Only (removal already pulled: %s)',
    async (pullWhilePrivate) => {
      const server = new MemoryServer()
      const { db, repo, collection, entry, engine } = await syncedEntry(server)
      const photo = await addPhoto(repo, entry.id)
      await engine.syncNow()
      await repo.setStorageMode(collection.id, 'local_only', { consentToUploadExisting: false })
      await repo.updateEntry(entry.id, { quantity: '27', notes: 'Changed on this device' })
      server.records.delete(server.key('collection', collection.id))
      server.records.delete(server.key('item', entry.item_id))
      server.records.delete(server.key('entry', entry.id))
      server.records.delete(server.key('photo', photo.id))
      server.stored.delete(photo.id)
      server.pageSize = 1
      server.pushChange({ entity: 'photo', id: photo.id, purged: true })
      server.pushChange({ entity: 'item', id: entry.item_id, purged: true })
      server.pushChange({ entity: 'collection', id: collection.id, removed: true })
      if (pullWhilePrivate) await engine.syncNow()
      const apply = server.applyMutation.bind(server)
      vi.spyOn(server, 'applyMutation').mockImplementation((mutation) => {
        if (
          (mutation.entity !== 'item' && mutation.entity !== 'entry') ||
          server.records.has(server.key('collection', mutation.collection_id))
        )
          return apply(mutation)
        const rejected = {
          id: mutation.id,
          status: 'rejected',
          code: 'missing_parent',
          message: 'Collection does not exist',
          server_revision: null,
        }
        server.mutationResults.set(mutation.id, rejected)
        return rejected
      })
      await repo.setStorageMode(collection.id, 'synced', { consentToUploadExisting: true })
      const previousIds = new Set((await db.outbox.toArray()).map((row) => row.id))
      const offset = server.batchRequests.length
      for (let cycle = 0; cycle < 5; cycle++) await engine.syncNow()

      const creates = server.batchRequests
        .slice(offset)
        .flat()
        .filter((row) => row.base_revision === null)
      expect(creates.map((row) => row.entity).sort()).toEqual(['collection', 'entry', 'item', 'photo'])
      expect(creates.every((row) => row.op === 'upsert' && !previousIds.has(row.id))).toBe(true)
      expect(server.records.get(server.key('entry', entry.id))).toMatchObject({
        quantity: '27',
        sequence_number: entry.sequence_number,
      })
      expect(server.records.get(server.key('item', entry.item_id))?.notes).toBe('Changed on this device')
      expect(await db.photos.get(photo.id)).toMatchObject({ upload_state: 'uploaded' })
      expect(server.stored.has(photo.id)).toBe(true)
      expect(await db.outbox.count()).toBe(0)
      await db.delete()
    },
  )

  it('keeps a previously shared sequence number when a recreation runs into a taken number', async () => {
    const server = new MemoryServer()
    const { db, repo, collection, entry, engine } = await syncedEntry(server)
    await repo.setStorageMode(collection.id, 'local_only', { consentToUploadExisting: false })
    const key = server.key('entry', entry.id)
    server.records.set(server.key('entry', 'other-entry'), {
      ...server.records.get(key)!,
      id: 'other-entry',
      item_id: 'other-item',
    })
    server.records.delete(key)
    await repo.setStorageMode(collection.id, 'synced', { consentToUploadExisting: true })

    for (let cycle = 0; cycle < 4; cycle++) await engine.syncNow()

    expect(await db.entries.get(entry.id)).toMatchObject({
      sequence_number: entry.sequence_number,
      sync_state: 'error',
    })
    expect(server.records.get(key)).toBeUndefined()
    await db.delete()
  })

  it('retargets rejected item edits and unsent photo edits to a surviving placement', async () => {
    const server = new MemoryServer()
    const { db, repo, collection, entry, engine } = await syncedEntry(server)
    const photo = await addPhoto(repo, entry.id)
    const other = await repo.createCollection({ name: 'Other', storage_mode: 'synced' })
    await repo.importEntries(other.id, [entry.id])
    await engine.syncNow()
    await repo.updateEntry(entry.id, { notes: 'Shared edit' })
    await repo.updatePhoto(photo.id, { caption: 'Shared caption' })
    const itemRow = (await db.outbox.where('[entity+entity_id]').equals(['item', entry.item_id]).first())!
    const photoRow = (await db.outbox.where('[entity+entity_id]').equals(['photo', photo.id]).first())!
    expect([itemRow.collection_id, photoRow.collection_id]).toEqual([collection.id, collection.id])
    server.records.delete(server.key('collection', collection.id))
    const apply = server.applyMutation.bind(server)
    vi.spyOn(server, 'applyMutation').mockImplementation((mutation) => {
      if (mutation.collection_id !== collection.id) return apply(mutation)
      const rejected = {
        id: mutation.id,
        status: 'rejected',
        code: 'missing_parent',
        message: 'Collection does not exist',
        server_revision: null,
      }
      server.mutationResults.set(mutation.id, rejected)
      return rejected
    })
    await db.outbox.update(photoRow.id, { next_attempt_at: '2026-11-09T00:00:00.000Z' })
    server.pushChange({ entity: 'collection', id: collection.id, removed: true })
    await engine.runScheduledCycle()

    expect(await db.outbox.get(itemRow.id)).toBeUndefined()
    expect(await db.outbox.where('[entity+entity_id]').equals(['item', entry.item_id]).first()).toMatchObject(
      {
        collection_id: other.id,
        fields: { notes: 'Shared edit' },
      },
    )
    expect(await db.outbox.get(photoRow.id)).toMatchObject({ collection_id: other.id })
    await engine.syncNow()
    expect(server.records.get(server.key('item', entry.item_id))?.notes).toBe('Shared edit')
    expect(server.records.get(server.key('photo', photo.id))?.caption).toBe('Shared caption')
    expect(await db.outbox.count()).toBe(0)
    await db.delete()
  })

  it('reports a remotely shared private item while syncing only the acknowledged placement edits', async () => {
    const server = new MemoryServer()
    const { db, repo, collection, entry, engine } = await syncedEntry(server)
    const other = await repo.createCollection({ name: 'Other', storage_mode: 'synced' })
    const localPhoto = await addPhoto(repo, entry.id)
    await engine.syncNow()
    await repo.setStorageMode(collection.id, 'local_only', { consentToUploadExisting: false })
    await repo.updateEntry(entry.id, { notes: 'Private draft' })
    const remoteId = 'remote-entry'
    expect(
      server.applyMutation({
        id: 'share-item',
        entity: 'entry',
        entity_id: remoteId,
        collection_id: other.id,
        op: 'upsert',
        base_revision: null,
        fields: { ...server.records.get(server.key('entry', entry.id)), collection_id: other.id },
      }),
    ).toMatchObject({ status: 'applied' })
    await engine.syncNow()
    expect((await repo.getEntry(remoteId))?.display_sync_state).toBe('error')
    expect(await waitForStatus(engine, (value) => !!value.per_collection[other.id]?.errors)).toMatchObject({
      last_error: expect.stringContaining('Local Only'),
    })
    await repo.updateEntry(remoteId, { quantity: '12', notes: 'Keep this private' })
    await repo.updatePhoto(localPhoto.id, { caption: 'Private caption' })
    const added = await addPhoto(repo, remoteId)
    const offset = server.batchRequests.length
    await engine.syncNow()
    expect(server.batchRequests.slice(offset).flat()).toEqual([
      expect.objectContaining({ entity: 'entry', entity_id: remoteId, fields: { quantity: '12' } }),
    ])
    expect(server.records.get(server.key('entry', remoteId))?.quantity).toBe('12')
    expect(server.records.get(server.key('item', entry.item_id))?.notes).toBe('initial')
    expect(server.stored.has(added.id)).toBe(false)
    expect((await repo.getEntry(remoteId))?.display_sync_state).toBe('error')
    await db.delete()
  })

  it.each(['/api/sync/batch', '/api/sync/changes'])(
    'halts on client_outdated from %s until Sync Now',
    async (path) => {
      const server = new MemoryServer()
      const { name, db, repo, entry } = await syncedEntry(server)
      await repo.updateEntry(entry.id, { quantity: '4' })
      const fetch = server.fetch
      let outdated = true
      server.fetch = async (input, init) => {
        if (String(input).startsWith(path) && outdated) {
          server.requests.push({ url: String(input), method: init?.method ?? 'GET' })
          return new Response(JSON.stringify({ detail: 'client_outdated' }), { status: 409 })
        }
        return fetch(input, init)
      }
      const engine = makeEngine(name, server)
      await engine.syncNow()
      expect(server.requests.at(-1)?.url).toMatch(new RegExp('^' + path))
      const offset = server.requests.length
      await engine.runScheduledCycle()
      await engine.runScheduledCycle()
      expect(server.requests.slice(offset)).toEqual([])
      outdated = false
      await engine.syncNow()
      expect(await db.outbox.count()).toBe(0)
      await db.delete()
    },
  )

  it('upgrades v2 databases without losing existing photo data and initializes retry metadata', async () => {
    const name = dbName()
    const legacy = new Dexie(name)
    legacy.version(1).stores({
      collections: 'id, status, storage_mode, updated_at',
      entries:
        'id, [collection_id+sequence_number], [collection_id+deleted_at], [collection_id+updated_at], collection_id',
      photos:
        'id, [entry_id+sort_order], entry_id, collection_id, [collection_id+deleted_at], [collection_id+captured_at], [entry_id+deleted_at]',
      photoBlobs: 'photo_id',
      outbox:
        'id, [collection_id+entity_id], [collection_id+entity+entity_id], next_attempt_at, collection_id',
      settings: 'key',
    })
    legacy.version(2).stores({ conflicts: 'id, collection_id, [entity+entity_id], created_at' })
    await legacy.open()
    const original = {
      id: 'legacy-photo',
      entry_id: 'legacy-entry',
      collection_id: 'legacy-collection',
      sort_order: 0,
      original_filename: 'legacy.jpg',
      mime_type: 'image/jpeg',
      byte_size: 4,
      width: 1,
      height: 1,
      sha256: 'a'.repeat(64),
      crc32: 1,
      captured_at: '2026-11-08T00:00:00.000Z',
      capture_source: 'photo_library',
      caption: '',
      is_cover: true,
      deleted_at: null,
      upload_state: 'error',
      server_storage_key: null,
      created_at: '2026-11-08T00:00:00.000Z',
      updated_at: '2026-11-08T00:00:00.000Z',
      revision: 1,
      server_revision: null,
      sync_state: 'pending',
    }
    await legacy.table('photos').put(original)
    legacy.close()

    const upgraded = getCaptureDb(name)
    const photo = await upgraded.photos.get('legacy-photo')
    expect(photo).toMatchObject({
      id: 'legacy-photo',
      byte_size: 4,
      upload_state: 'error',
      upload_attempts: 0,
      upload_next_attempt_at: null,
    })
    await upgraded.delete()
  })

  it('coalesces two edits into one mutation with latest values and acknowledges its revision', async () => {
    const server = new MemoryServer()
    const fixture = await syncedEntry(server)
    await fixture.repo.updateEntry(fixture.entry.id, { notes: 'first edit' })
    await fixture.repo.updateEntry(fixture.entry.id, { notes: 'latest edit', title: 'Latest title' })
    const outboxBefore = await fixture.db.outbox
      .where('[entity+entity_id]')
      .equals(['item', fixture.entry.id])
      .toArray()
    expect(outboxBefore).toHaveLength(1)
    await fixture.engine.syncNow()
    const sent = server.batchRequests.at(-1)!.filter((item) => item.entity === 'item')
    const local = await fixture.db.items.get(fixture.entry.id)
    expect(sent).toHaveLength(1)
    expect(sent[0]!.fields).toMatchObject({ notes: 'latest edit', title: 'Latest title' })
    expect(local?.server_revision).toBe(server.records.get(server.key('item', fixture.entry.id))!.revision)
    expect(local?.sync_state).toBe('synced')
    await fixture.db.delete()
  })

  it('retries an applied batch with the same ids after losing the response and drains only on duplicate acknowledgement', async () => {
    const server = new MemoryServer()
    const fixture = await syncedEntry(server)
    await fixture.repo.updateEntry(fixture.entry.id, { notes: 'retry me' })
    const before = await fixture.db.outbox
      .where('[entity+entity_id]')
      .equals(['item', fixture.entry.id])
      .first()
    server.failAfterBatch = true
    await fixture.engine.syncNow()
    expect(await fixture.db.outbox.get(before!.id)).toMatchObject({ in_flight: false, attempts: 1 })
    await fixture.repo.updateEntry(fixture.entry.id, { notes: 'new edit after lost ack' })
    expect(
      await fixture.db.outbox.where('[entity+entity_id]').equals(['item', fixture.entry.id]).count(),
    ).toBe(2)
    fixedNow.value = new Date(fixedNow.value.getTime() + 10_000)
    await fixture.engine.syncNow()
    await fixture.engine.syncNow()
    const sentIds = server.batchRequests
      .slice(-2)
      .map((batch) => batch.find((item) => item.entity_id === fixture.entry.id)!.id)
    expect(sentIds[0]).toBe(before!.id)
    expect(sentIds[1]).not.toBe(before!.id)
    expect(server.records.get(server.key('item', fixture.entry.id))?.notes).toBe('new edit after lost ack')
    expect(server.records.get(server.key('item', fixture.entry.id))).toBeDefined()
    expect(server.records.get(server.key('entry', fixture.entry.id))).toBeDefined()
    expect(await fixture.db.outbox.get(before!.id)).toBeUndefined()
    await fixture.db.delete()
  })

  it('rebases edits made while a create or update is in flight and sends only one mutation per record', async () => {
    const server = new MemoryServer()
    const name = dbName()
    const repo = makeRepo(name)
    const collection = await repo.createCollection({ name: 'Room', storage_mode: 'synced' })
    const entry = await repo.createEntry(collection.id, { title: 'first' })
    let release!: () => void
    let reached!: () => void
    let hold = true
    const entered = new Promise<void>((resolve) => (reached = resolve))
    const gate = new Promise<void>((resolve) => (release = resolve))
    const fetcher = async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const url = String(input)
      if (url === '/api/sync/batch' && hold) {
        hold = false
        const response = await server.fetch(input, init)
        reached()
        await gate
        return response
      }
      return server.fetch(input, init)
    }
    const engine = createSyncEngine({ repoDbName: name, fetch: fetcher as typeof fetch, now: clock })
    const firstSync = engine.syncNow()
    await entered
    await repo.updateEntry(entry.id, { title: 'typed during create' })
    const batch = server.batchRequests[0]!
    expect(
      batch.filter((mutation) => mutation.entity_id === entry.id && mutation.entity === 'item'),
    ).toHaveLength(1)
    release()
    await firstSync
    await engine.syncNow()
    expect(server.records.get(server.key('item', entry.id))?.title).toBe('typed during create')
    expect(await getCaptureDb(name).conflicts.count()).toBe(0)

    await repo.updateEntry(entry.id, { title: 'first update' })
    let releaseUpdate!: () => void
    let reachedUpdate!: () => void
    const updateEntered = new Promise<void>((resolve) => (reachedUpdate = resolve))
    const updateGate = new Promise<void>((resolve) => (releaseUpdate = resolve))
    const updateEngine = createSyncEngine({
      repoDbName: name,
      fetch: (async (input: RequestInfo | URL, init: RequestInit = {}) => {
        if (String(input) === '/api/sync/batch') {
          const response = await server.fetch(input, init)
          reachedUpdate()
          await updateGate
          return response
        }
        return server.fetch(input, init)
      }) as typeof fetch,
      now: clock,
    })
    const updateSync = updateEngine.syncNow()
    await updateEntered
    await repo.updateEntry(entry.id, { title: 'second update' })
    await repo.updateEntry(entry.id, { title: 'latest update' })
    releaseUpdate()
    await updateSync
    await updateEngine.syncNow()
    expect(server.records.get(server.key('item', entry.id))?.title).toBe('latest update')
    expect(await getCaptureDb(name).conflicts.count()).toBe(0)
    await getCaptureDb(name).delete()
  })

  it('keeps an R2 rebase blocked when another device changed an R2 field during R1', async () => {
    const server = new MemoryServer()
    const fixture = await syncedEntry(server)
    let release!: () => void
    let entered!: () => void
    const requestEntered = new Promise<void>((resolve) => (entered = resolve))
    const gate = new Promise<void>((resolve) => (release = resolve))
    let hold = true
    const engine = createSyncEngine({
      repoDbName: fixture.name,
      fetch: (async (input: RequestInfo | URL, init: RequestInit = {}) => {
        if (String(input) === '/api/sync/batch' && hold) {
          hold = false
          entered()
          await gate
        }
        return server.fetch(input, init)
      }) as typeof fetch,
      now: clock,
    })

    await fixture.repo.updateEntry(fixture.entry.id, { title: 'R1 title' })
    const r1 = engine.syncNow()
    await requestEntered
    await fixture.repo.updateEntry(fixture.entry.id, { notes: 'local R2 notes' })
    server.externalUpdate('item', fixture.entry.id, { notes: 'remote R2 notes' })
    release()
    await r1
    await engine.syncNow()

    const conflict = await fixture.db.conflicts
      .where('[entity+entity_id]')
      .equals(['item', fixture.entry.id])
      .first()
    expect(conflict).toMatchObject({
      fields: ['notes'],
      local_values: { notes: 'local R2 notes' },
      server_values: { notes: 'remote R2 notes' },
    })
    expect((await fixture.repo.getEntry(fixture.entry.id))?.notes).toBe('local R2 notes')
    await fixture.db.delete()
  })

  it('resumes a stored upload by HEAD after stopping one engine, without storing it twice', async () => {
    const server = new MemoryServer()
    const fixture = await syncedEntry(server)
    const photo = await addPhoto(fixture.repo, fixture.entry.id)
    let started!: () => void
    const putStarted = new Promise<void>((resolve) => {
      started = resolve
    })
    const originalFetch = server.fetch
    server.fetch = async (input, init = {}) => {
      if (String(input).endsWith('/original') && init.method === 'PUT') {
        server.requests.push({ url: String(input), method: 'PUT', body: init.body })
        const digest = new Headers(init.headers).get('X-Content-SHA256')!
        server.stored.set(photo.id, { sha256: digest, byte_size: photo.byte_size, key: `media/${photo.id}` })
        started()
        return new Promise<Response>((_, reject) =>
          init.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), {
            once: true,
          }),
        )
      }
      return originalFetch(input, init)
    }
    const firstEngine = makeEngine(fixture.name, server)
    const pending = firstEngine.syncNow()
    await putStarted
    firstEngine.stop()
    await pending
    expect((await fixture.db.photos.get(photo.id))?.upload_state).toBe('pending')
    expect((await fixture.db.photos.get(photo.id))?.upload_attempts ?? 0).toBe(0)
    expect(await waitForStatus(firstEngine, () => true)).toMatchObject({ upload_progress: null })
    const secondEngine = makeEngine(fixture.name, server)
    secondEngine.start()
    await waitFor(async () => (await fixture.db.photos.get(photo.id))?.upload_state === 'uploaded')
    secondEngine.stop()
    expect((await fixture.db.photos.get(photo.id))?.upload_state).toBe('uploaded')
    expect(
      server.requests.filter((request) => request.url.endsWith('/original') && request.method === 'HEAD'),
    ).toHaveLength(2)
    expect(
      server.requests.filter((request) => request.url.endsWith('/original') && request.method === 'PUT'),
    ).toHaveLength(1)
    expect(server.stored.size).toBe(1)
    await fixture.db.delete()
  })

  it('derives entry status from photos, heals legacy pending state, and surfaces item conflicts', async () => {
    const server = new MemoryServer()
    const fixture = await syncedEntry(server)
    const photo = await addPhoto(fixture.repo, fixture.entry.id)
    expect((await fixture.db.entries.get(fixture.entry.id))?.sync_state).toBe('synced')
    await fixture.engine.syncNow()
    expect((await fixture.db.photos.get(photo.id))?.upload_state).toBe('uploaded')
    expect((await fixture.repo.getEntry(fixture.entry.id))?.display_sync_state).toBe('synced')

    await fixture.db.outbox.clear()
    const entry = (await fixture.db.entries.get(fixture.entry.id))!
    await fixture.db.entries.put({ ...entry, sync_state: 'pending', server_revision: 1 })
    expect((await fixture.repo.getEntry(fixture.entry.id))?.display_sync_state).toBe('synced')

    await fixture.db.conflicts.put({
      id: 'item-conflict',
      collection_id: fixture.collection.id,
      entity: 'item',
      entity_id: fixture.entry.id,
      fields: ['title'],
      local_values: { title: 'local' },
      server_values: { title: 'server' },
      server_revision: 2,
      created_at: clock().toISOString(),
    })
    expect((await fixture.repo.getEntry(fixture.entry.id))?.display_sync_state).toBe('conflict')
    await fixture.db.delete()
  })

  it('keeps and repairs the local next sequence when a lower collection counter is pulled', async () => {
    const server = new MemoryServer()
    const fixture = await syncedEntry(server)
    const collection = (await fixture.db.collections.get(fixture.collection.id))!
    await fixture.db.collections.put({ ...collection, next_sequence_number: 20 })
    const deletedEntry = (await fixture.db.entries.get(fixture.entry.id))!
    await fixture.db.entries.put({ ...deletedEntry, sequence_number: 9, deleted_at: clock().toISOString() })
    const remote = server.records.get(server.key('collection', fixture.collection.id))!

    server.pushChange({
      entity: 'collection',
      id: fixture.collection.id,
      record: { ...remote, next_sequence_number: 1 },
    })
    await fixture.engine.syncNow()
    expect((await fixture.db.collections.get(fixture.collection.id))?.next_sequence_number).toBe(20)

    const local = (await fixture.db.collections.get(fixture.collection.id))!
    await fixture.db.collections.put({ ...local, next_sequence_number: 1 })
    server.pushChange({
      entity: 'collection',
      id: fixture.collection.id,
      record: { ...remote, next_sequence_number: 1 },
    })
    await fixture.engine.syncNow()
    expect((await fixture.db.collections.get(fixture.collection.id))?.next_sequence_number).toBe(10)
    await fixture.db.delete()
  })

  it('queues and syncs the collection counter whenever a new entry is allocated', async () => {
    const server = new MemoryServer()
    const fixture = await syncedEntry(server)
    const added = await fixture.repo.createEntry(fixture.collection.id)
    const queued = await fixture.db.outbox
      .where('[entity+entity_id]')
      .equals(['collection', fixture.collection.id])
      .toArray()
    expect(queued.some((item) => item.fields.next_sequence_number === added.sequence_number + 1)).toBe(true)
    await fixture.engine.syncNow()
    expect(server.records.get(server.key('collection', fixture.collection.id))?.next_sequence_number).toBe(
      added.sequence_number + 1,
    )
    await fixture.db.delete()
  })

  it('resumes an unstored upload with HEAD 404 followed by one PUT', async () => {
    const server = new MemoryServer()
    const fixture = await syncedEntry(server)
    const photo = await addPhoto(fixture.repo, fixture.entry.id)
    let started!: () => void
    const putStarted = new Promise<void>((resolve) => {
      started = resolve
    })
    const originalFetch = server.fetch
    let stalledOnce = false
    server.fetch = async (input, init = {}) => {
      if (String(input).endsWith('/original') && init.method === 'PUT' && !stalledOnce) {
        stalledOnce = true
        server.requests.push({ url: String(input), method: 'PUT', body: init.body })
        started()
        return new Promise<Response>((_, reject) =>
          init.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), {
            once: true,
          }),
        )
      }
      return originalFetch(input, init)
    }
    const firstEngine = makeEngine(fixture.name, server)
    const pending = firstEngine.syncNow()
    await putStarted
    firstEngine.stop()
    await pending
    const secondEngine = makeEngine(fixture.name, server)
    secondEngine.start()
    await waitFor(async () => (await fixture.db.photos.get(photo.id))?.upload_state === 'uploaded')
    secondEngine.stop()
    expect((await fixture.db.photos.get(photo.id))?.upload_state).toBe('uploaded')
    expect(
      server.requests.filter((request) => request.url.endsWith('/original') && request.method === 'HEAD'),
    ).toHaveLength(2)
    expect(
      server.requests.filter((request) => request.url.endsWith('/original') && request.method === 'PUT'),
    ).toHaveLength(2)
    expect(server.stored.size).toBe(1)
    await fixture.db.delete()
  })

  it('records a checksum mismatch as an upload error and schedules exponential retry', async () => {
    const server = new MemoryServer()
    const fixture = await syncedEntry(server)
    const photo = await addPhoto(fixture.repo, fixture.entry.id)
    server.mismatchUpload = true
    await fixture.engine.runScheduledCycle()
    const failed = (await fixture.db.photos.get(photo.id)) as Photo & {
      upload_attempts: number
      upload_next_attempt_at: string | null
    }
    expect(failed.upload_state).toBe('error')
    expect(failed.upload_attempts).toBe(1)
    expect(failed.upload_next_attempt_at).not.toBeNull()
    expect(failed.upload_next_attempt_at! > clock().toISOString()).toBe(true)
    server.mismatchUpload = false
    // A scheduled cycle respects the backoff: no second PUT yet.
    await fixture.engine.runScheduledCycle()
    expect(
      server.requests.filter((request) => request.url.endsWith('/original') && request.method === 'PUT'),
    ).toHaveLength(1)
    fixedNow.value = new Date(failed.upload_next_attempt_at!)
    await fixture.engine.runScheduledCycle()
    expect((await fixture.db.photos.get(photo.id))?.upload_state).toBe('uploaded')
  })

  it.each([false, true])('retries an original after a watchdog timeout (body sent: %s)', async (bodySent) => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const server = new MemoryServer()
    const { name, repo, entry, db } = await syncedEntry(server)
    const photo = await addPhoto(repo, entry.id)
    const other = await addPhoto(repo, entry.id)
    const storedBlob = vi.spyOn(captureDb, 'readPhotoBlob')
    const started = deferred<TestUpload>()
    const originals: TestUpload[] = []
    const engine = makeEngine(name, server, {
      xhrFactory: xhrFactory((xhr) => {
        if (xhr.url.endsWith('/original')) {
          originals.push(xhr)
          if (originals.length === 1) {
            if (bodySent) xhr.upload.onload?.()
            started.resolve(xhr)
            return
          }
        }
        void xhr.reply(server.fetch)
      }),
    })
    const cycle = engine.runScheduledCycle()
    const xhr = await started.promise
    const timeout = bodySent ? 60_000 : 45_000
    await vi.advanceTimersByTimeAsync(timeout - 1)
    expect(xhr.aborted).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    await cycle
    expect(xhr.aborted).toBe(true)
    expect(originals).toHaveLength(1)
    expect(await db.photos.get(photo.id)).toMatchObject({
      upload_state: 'error',
      upload_attempts: 1,
      upload_next_attempt_at: new Date(clock().getTime() + 2_000).toISOString(),
      upload_error: 'Connection stalled. Will retry.',
    })
    expect(await db.photos.get(other.id)).toMatchObject({ upload_state: 'pending' })
    expect(await waitForStatus(engine, (status) => status.phase === 'error')).toMatchObject({
      last_error: 'Connection stalled. Will retry.',
      upload_progress: null,
    })
    await setLocale('zh-CN', { reload: false })
    fixedNow.value = new Date(clock().getTime() + 1_999)
    try {
      await engine.runScheduledCycle()
      expect(originals.filter((request) => request.url === xhr.url)).toHaveLength(1)
      expect(await waitForStatus(engine, (status) => status.phase === 'idle')).toMatchObject({
        last_error: '连接超时，将重试。',
      })
    } finally {
      await setLocale('en', { reload: false })
    }
    fixedNow.value = new Date(clock().getTime() + 1)
    await engine.runScheduledCycle()
    const [first, retry] = originals.filter((request) => request.url === xhr.url)
    expect(retry?.body).toBe(
      (await storedBlob.mock.results.filter(({ type }) => type === 'return').at(-1)?.value)?.original,
    )
    expect(first?.body).toBe((await storedBlob.mock.results[0]?.value)?.original)
    expect(await retry?.body.arrayBuffer()).toEqual(await first?.body.arrayBuffer())
    expect(retry?.headers.get('X-Content-SHA256')).toBe(photo.sha256)
    expect(await db.photos.get(photo.id)).toMatchObject({ upload_state: 'uploaded', upload_attempts: 0 })
    expect(await waitForStatus(engine, (status) => status.phase === 'idle')).toMatchObject({
      upload_progress: null,
    })
    await db.delete()
  })

  it('allows an original to progress every 10 seconds for three minutes', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const server = new MemoryServer()
    const { name, repo, entry, db } = await syncedEntry(server)
    const [photo] = await repo.addPhotos(entry.id, [
      { blob: new NodeBlob(['original'.repeat(100)]), source: 'photo_library' },
    ])
    const started = deferred<TestUpload>()
    const engine = makeEngine(name, server, {
      xhrFactory: xhrFactory((xhr) => {
        if (xhr.url.endsWith('/original')) started.resolve(xhr)
        else void xhr.reply(server.fetch)
      }),
    })
    const cycle = engine.runScheduledCycle()
    const xhr = await started.promise
    for (let step = 1; step <= 18; step++) {
      await vi.advanceTimersByTimeAsync(10_000)
      expect(xhr.aborted).toBe(false)
      xhr.upload.onprogress?.({ loaded: step * 40 })
    }
    xhr.upload.onload?.()
    await xhr.reply(server.fetch)
    await cycle
    expect(await db.photos.get(photo!.id)).toMatchObject({ upload_state: 'uploaded' })
    await db.delete()
  })

  it('times out a thumbnail without displaying its progress, unmarking or reuploading the verified original', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const server = new MemoryServer()
    const { name, repo, entry, db } = await syncedEntry(server)
    const photo = await addPhoto(repo, entry.id)
    const started = deferred<TestUpload>()
    const engine = makeEngine(name, server, {
      timeouts: { uploadStallMs: 500 },
      xhrFactory: xhrFactory((xhr) => {
        if (xhr.url.endsWith('/thumbnail')) started.resolve(xhr)
        else void xhr.reply(server.fetch)
      }),
    })
    const cycle = engine.runScheduledCycle()
    const xhr = await started.promise
    expect(await waitForStatus(engine, () => true)).toMatchObject({ upload_progress: null })
    await vi.advanceTimersByTimeAsync(500)
    await cycle
    expect(xhr.aborted).toBe(true)
    expect(await db.photos.get(photo.id)).toMatchObject({
      upload_state: 'uploaded',
      upload_attempts: 0,
      upload_error: null,
      server_storage_key: `media/${photo.id}`,
    })
    expect(await waitForStatus(engine, (status) => status.phase === 'idle')).toMatchObject({
      last_error: null,
      pending_uploads: 0,
    })
    await engine.syncNow()
    expect(await db.photos.get(photo.id)).toMatchObject({ upload_state: 'uploaded' })
    expect(
      server.requests.filter(({ url, method }) => url.endsWith('/original') && method === 'PUT'),
    ).toHaveLength(1)
    await db.delete()
  })

  it.each(['/api/auth/session', '/api/sync/batch', '/api/sync/changes', 'HEAD'])(
    'leaves the cycle retryable after %s hangs for 30 seconds',
    async (target) => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
      const server = new MemoryServer()
      const { name, repo, entry, db } = await syncedEntry(server)
      const photo = await addPhoto(repo, entry.id)
      const started = deferred<AbortSignal>()
      let hang = true
      const engine = makeEngine(name, server, {
        fetch: async (input, init) => {
          if (hang && (target === 'HEAD' ? init?.method === 'HEAD' : String(input).startsWith(target))) {
            hang = false
            started.resolve(init!.signal!)
            return new Promise(() => {})
          }
          return server.fetch(input, init)
        },
      })
      const cycle = engine.runScheduledCycle()
      const signal = await started.promise
      await vi.advanceTimersByTimeAsync(29_999)
      expect(signal.aborted).toBe(false)
      await vi.advanceTimersByTimeAsync(1)
      await cycle
      expect(signal.aborted).toBe(true)
      expect(await waitForStatus(engine, (status) => status.phase === 'error')).toMatchObject({
        last_error: 'Connection stalled. Will retry.',
        upload_progress: null,
      })
      if (target === '/api/sync/batch') {
        expect(await db.outbox.toArray()).toEqual([
          expect.objectContaining({
            entity_id: photo.id,
            attempts: 1,
            in_flight: false,
            last_error: 'Connection stalled. Will retry.',
            next_attempt_at: new Date(clock().getTime() + 2_000).toISOString(),
          }),
        ])
      }
      if (target === 'HEAD') {
        expect(await db.photos.get(photo.id)).toMatchObject({
          upload_state: 'error',
          upload_attempts: 1,
          upload_error: 'Connection stalled. Will retry.',
        })
      }
      await engine.syncNow()
      expect(await db.outbox.count()).toBe(0)
      expect(await db.photos.get(photo.id)).toMatchObject({ upload_state: 'uploaded' })
      await db.delete()
    },
  )

  it('publishes progress and distinct totals for three originals, including one shared photo', async () => {
    const server = new MemoryServer()
    const { name, repo, collection, entry, db } = await syncedEntry(server)
    const other = await repo.createCollection({ name: 'Other room', storage_mode: 'synced' })
    const shared = await repo.createEntry(collection.id)
    await repo.importEntries(other.id, [shared.id])
    const otherEntry = await repo.createEntry(other.id)
    const alreadyStored = await addPhoto(repo, entry.id)
    server.stored.set(alreadyStored.id, {
      sha256: alreadyStored.sha256,
      byte_size: alreadyStored.byte_size,
      key: `media/${alreadyStored.id}`,
    })
    const photos = []
    for (const placement of [entry, shared, otherEntry]) {
      fixedNow.value = new Date(clock().getTime() + 1_000)
      photos.push(await addPhoto(repo, placement.id))
    }
    const progressStatus: Array<PhotoUploadProgress | null> = []
    const engine = makeEngine(name, server, {
      xhrFactory: xhrFactory((xhr) => {
        if (xhr.url.endsWith('/original')) {
          xhr.upload.onprogress?.({ loaded: 5 })
          const emissions = progressStatus.length
          xhr.upload.onprogress?.({ loaded: 5 })
          expect(progressStatus).toHaveLength(emissions)
          xhr.upload.onload?.()
        }
        void xhr.reply(server.fetch)
      }),
    })
    engine.status.subscribe((status) => progressStatus.push(status.upload_progress))
    await engine.runScheduledCycle()
    const [first, second, third] = photos.map(({ id }) =>
      progressStatus.filter((progress) => progress?.photo_id === id),
    )
    expect(first?.[0]).toMatchObject({
      n: 1,
      total: 3,
      collection_ids: [collection.id],
      per_collection: { [collection.id]: { n: 1, total: 2 } },
    })
    expect(second?.[0]).toMatchObject({
      n: 2,
      total: 3,
      collection_ids: expect.arrayContaining([collection.id, other.id]),
      per_collection: { [collection.id]: { n: 2, total: 2 }, [other.id]: { n: 1, total: 2 } },
    })
    expect(third?.[0]).toMatchObject({
      n: 3,
      total: 3,
      collection_ids: [other.id],
      per_collection: { [other.id]: { n: 2, total: 2 } },
    })
    for (const updates of [first, second, third]) {
      expect([...new Set(updates?.map((progress) => progress?.sent_bytes))]).toEqual([0, 5, 11])
      expect([...new Set(updates?.map((progress) => progress?.percent))]).toEqual([0, 45, 100])
    }
    expect(progressStatus.at(-1)).toBeNull()
    expect(await db.photos.get(alreadyStored.id)).toMatchObject({ upload_state: 'uploaded' })
    expect(progressStatus.some((progress) => progress?.photo_id === alreadyStored.id)).toBe(false)
    await db.delete()
  })

  it('leaves photos kept private by a Local Only placement out of the upload totals', async () => {
    const server = new MemoryServer()
    const { name, repo, collection, entry, db } = await syncedEntry(server)
    const privateRoom = await repo.createCollection({ name: 'Private room', storage_mode: 'local_only' })
    const sharedWithPrivate = await repo.createEntry(collection.id)
    // A pull can leave an item placed in both a synced and a Local Only collection.
    const placement = (await db.entries.get(sharedWithPrivate.id))!
    await db.entries.put({
      ...placement,
      id: 'private-placement',
      collection_id: privateRoom.id,
      server_revision: null,
    })
    const privatePhoto = await addPhoto(repo, sharedWithPrivate.id)
    fixedNow.value = new Date(clock().getTime() + 1_000)
    const photo = await addPhoto(repo, entry.id)
    const progressStatus: Array<PhotoUploadProgress | null> = []
    const engine = makeEngine(name, server, {
      xhrFactory: xhrFactory((xhr) => {
        if (xhr.url.endsWith('/original')) xhr.upload.onload?.()
        void xhr.reply(server.fetch)
      }),
    })
    engine.status.subscribe((status) => progressStatus.push(status.upload_progress))
    await engine.runScheduledCycle()
    expect(progressStatus.filter((progress) => progress?.photo_id === photo.id)[0]).toMatchObject({
      n: 1,
      total: 1,
      per_collection: { [collection.id]: { n: 1, total: 1 } },
    })
    expect(progressStatus.some((progress) => progress?.photo_id === privatePhoto.id)).toBe(false)
    expect(await db.photos.get(photo.id)).toMatchObject({ upload_state: 'uploaded' })
    expect(server.requests.some(({ url }) => url.includes(privatePhoto.id))).toBe(false)
    await db.delete()
  })

  it('retries immediately when the user taps Sync Now, ignoring the backoff window', async () => {
    const server = new MemoryServer()
    const fixture = await syncedEntry(server)
    const photo = await addPhoto(fixture.repo, fixture.entry.id)
    server.mismatchUpload = true
    await fixture.engine.runScheduledCycle()
    expect((await fixture.db.photos.get(photo.id))?.upload_state).toBe('error')
    server.mismatchUpload = false
    await fixture.engine.syncNow()
    expect((await fixture.db.photos.get(photo.id))?.upload_state).toBe('uploaded')
    await fixture.db.delete()
    await fixture.db.delete()
  })

  it('stores field conflict values and resolves mine with a new mutation based on server revision', async () => {
    const server = new MemoryServer()
    const fixture = await syncedEntry(server)
    server.externalUpdate('item', fixture.entry.id, { notes: 'server note' })
    await fixture.repo.updateEntry(fixture.entry.id, { notes: 'local note' })
    const firstId = (await fixture.db.outbox
      .where('[entity+entity_id]')
      .equals(['item', fixture.entry.id])
      .first())!.id
    await fixture.engine.syncNow()
    const conflict = await fixture.db.conflicts
      .where('[entity+entity_id]')
      .equals(['item', fixture.entry.id])
      .first()
    expect(conflict).toMatchObject({
      local_values: { notes: 'local note' },
      server_values: { notes: 'server note' },
    })
    await fixture.engine.resolveConflict(conflict!.id, 'mine')
    await waitFor(
      async () =>
        (await fixture.db.outbox.where('[entity+entity_id]').equals(['item', fixture.entry.id]).count()) ===
        0,
    )
    const mine = server.batchRequests
      .flat()
      .filter((mutation) => mutation.entity_id === fixture.entry.id && mutation.fields.notes === 'local note')
      .at(-1)!
    expect(mine.id).not.toBe(firstId)
    expect(mine.base_revision).toBe(conflict!.server_revision)
    expect(server.records.get(server.key('item', fixture.entry.id))?.notes).toBe('local note')
    expect(await fixture.db.conflicts.count()).toBe(0)
    await fixture.db.delete()
  })

  it('resolves a field conflict with server values without sending another mutation', async () => {
    const server = new MemoryServer()
    const fixture = await syncedEntry(server)
    server.externalUpdate('item', fixture.entry.id, { title: 'Server title' })
    await fixture.repo.updateEntry(fixture.entry.id, { title: 'Mine title' })
    await fixture.engine.syncNow()
    const conflict = await fixture.db.conflicts
      .where('[entity+entity_id]')
      .equals(['item', fixture.entry.id])
      .first()
    const batchCount = server.batchRequests.length
    await fixture.engine.resolveConflict(conflict!.id, 'server')
    await waitFor(async () => (await fixture.db.conflicts.count()) === 0)
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect((await fixture.db.items.get(fixture.entry.id))?.title).toBe('Server title')
    expect(server.batchRequests).toHaveLength(batchCount)
    await fixture.db.delete()
  })

  it('discards queued edits to resolved fields while preserving the rest of the patch', async () => {
    const server = new MemoryServer()
    const { db, repo, entry, engine } = await syncedEntry(server)
    server.externalUpdate('item', entry.item_id, { title: 'Server title' })
    await repo.updateEntry(entry.id, { title: 'First local title' })
    await engine.syncNow()
    const conflict = (await db.conflicts.toArray())[0]!
    await repo.updateEntry(entry.id, { title: 'Later local title', notes: 'Preserve me' })
    const offset = server.batchRequests.length

    await engine.runScheduledCycle()
    expect(server.batchRequests).toHaveLength(offset)
    await engine.resolveConflict(conflict.id, 'server')

    await waitFor(async () => (await db.outbox.count()) === 0)
    expect(server.batchRequests.slice(offset).flat()).toEqual([
      expect.objectContaining({ entity_id: entry.item_id, fields: { notes: 'Preserve me' } }),
    ])
    expect(await db.items.get(entry.item_id)).toMatchObject({ title: 'Server title', notes: 'Preserve me' })
    expect(server.records.get(server.key('item', entry.item_id))).toMatchObject({
      title: 'Server title',
      notes: 'Preserve me',
    })
    await db.delete()
  })

  it('keeps conflicted local fields through pull until server resolution is chosen', async () => {
    const server = new MemoryServer()
    const fixture = await syncedEntry(server)
    server.externalUpdate('item', fixture.entry.id, { title: 'Server title' })
    await fixture.repo.updateEntry(fixture.entry.id, { title: 'Local title' })
    await fixture.engine.syncNow()
    const conflict = await fixture.db.conflicts
      .where('[entity+entity_id]')
      .equals(['item', fixture.entry.id])
      .first()
    expect(conflict).toBeDefined()
    expect((await fixture.repo.getEntry(fixture.entry.id))?.title).toBe('Local title')
    await fixture.engine.resolveConflict(conflict!.id, 'server')
    await waitFor(async () => (await fixture.db.conflicts.count()) === 0)
    expect((await fixture.repo.getEntry(fixture.entry.id))?.title).toBe('Server title')
    await fixture.db.delete()
  })

  it('treats a duplicate carrying a stored rejected outcome as rejected', async () => {
    const server = new MemoryServer()
    const fixture = await syncedEntry(server)
    await fixture.repo.updateEntry(fixture.entry.id, { title: 'bad value' })
    const fetcher = async (input: RequestInfo | URL, init: RequestInit = {}) => {
      if (String(input) === '/api/sync/batch') {
        const payload = JSON.parse(String(init.body)) as { mutations: Mutation[] }
        return new Response(
          JSON.stringify({
            results: payload.mutations.map((mutation) => ({
              id: mutation.id,
              status: 'duplicate',
              duplicate: true,
              code: 'invalid_field',
              message: 'Stored rejection.',
              server_revision: 0,
            })),
            cursor: 0,
          }),
          { status: 200 },
        )
      }
      return server.fetch(input, init)
    }
    const engine = createSyncEngine({ repoDbName: fixture.name, fetch: fetcher as typeof fetch, now: clock })
    await engine.syncNow()
    const queued = await fixture.db.outbox
      .where('[entity+entity_id]')
      .equals(['item', fixture.entry.id])
      .first()
    expect(queued).toMatchObject({ last_error: 'Stored rejection.', in_flight: false })
    expect((await fixture.db.items.get(fixture.entry.id))?.sync_state).toBe('error')
    await fixture.db.delete()
  })

  it('recovers an in-flight mutation on start and selects one mutation per record', async () => {
    const server = new MemoryServer()
    const fixture = await syncedEntry(server)
    await fixture.repo.updateEntry(fixture.entry.id, { notes: 'one' })
    const first = await fixture.db.outbox
      .where('[entity+entity_id]')
      .equals(['item', fixture.entry.id])
      .first()
    await fixture.db.outbox.put({ ...first!, in_flight: true, sent: true })
    const engine = makeEngine(fixture.name, server)
    engine.start()
    await waitFor(async () => (await fixture.db.outbox.get(first!.id)) === undefined)
    engine.stop()
    expect(
      server.batchRequests.at(-1)?.filter((mutation) => mutation.entity_id === fixture.entry.id),
    ).toHaveLength(1)
    await fixture.db.delete()
  })

  it('sends only the oldest queued mutation when a record has multiple rows', async () => {
    const server = new MemoryServer()
    const fixture = await syncedEntry(server)
    await fixture.repo.updateEntry(fixture.entry.id, { notes: 'first queued' })
    const first = (await fixture.db.outbox
      .where('[entity+entity_id]')
      .equals(['item', fixture.entry.id])
      .first())!
    await fixture.db.outbox.put({
      ...first,
      id: `later-${first.id}`,
      fields: { notes: 'second queued' },
      created_at: new Date(clock().getTime() + 1000).toISOString(),
      base_revision: first.base_revision,
    })
    await makeEngine(fixture.name, server).syncNow()
    const sent = server.batchRequests.at(-1)!.filter((mutation) => mutation.entity_id === fixture.entry.id)
    expect(sent).toHaveLength(1)
    expect(sent[0]?.id).toBe(first.id)
    expect(server.records.get(server.key('item', fixture.entry.id))?.notes).toBe('first queued')
    await fixture.db.delete()
  })

  it('allocates a fresh sequence after sequence_taken and applies it without reusing the taken number', async () => {
    const server = new MemoryServer()
    const fixture = await syncedEntry(server)
    const entry = await fixture.repo.createEntry(fixture.collection.id)
    const collectionRecord = server.records.get(server.key('collection', fixture.collection.id))!
    server.records.set(server.key('collection', fixture.collection.id), {
      ...collectionRecord,
      next_sequence_number: 8,
    })
    server.records.set('entry:other-device-entry', {
      id: 'other-device-entry',
      collection_id: fixture.collection.id,
      sequence_number: entry.sequence_number,
      revision: 1,
      field_revisions: {},
    })
    await fixture.engine.syncNow()
    const reallocated = await fixture.db.entries.get(entry.id)
    expect(reallocated?.sequence_number).toBeGreaterThanOrEqual(8)
    expect(reallocated?.sequence_number).not.toBe(entry.sequence_number)
    await fixture.engine.syncNow()
    expect(server.records.get(server.key('entry', entry.id))?.sequence_number).toBe(
      reallocated?.sequence_number,
    )
    const localSequences = (
      await fixture.db.entries.where('collection_id').equals(fixture.collection.id).toArray()
    ).map((item) => item.sequence_number)
    expect(new Set(localSequences).size).toBe(localSequences.length)
    expect((await fixture.db.collections.get(fixture.collection.id))?.next_sequence_number).toBeGreaterThan(
      reallocated!.sequence_number,
    )
    await fixture.db.delete()
  })

  it('merges pending local fields with server changes, pages changes, and removes purged/removed records', async () => {
    const server = new MemoryServer()
    const fixture = await syncedEntry(server)
    server.pageSize = 1
    await fixture.repo.updateEntry(fixture.entry.id, { notes: 'local pending' })
    server.externalUpdate('item', fixture.entry.id, { title: 'Server title' })
    const remoteEntry = {
      ...server.records.get(server.key('item', fixture.entry.id))!,
      notes: 'server note',
    }
    server.pushChange({ entity: 'item', id: fixture.entry.id, record: remoteEntry })
    await fixture.engine.syncNow()
    const merged = await fixture.db.entries.get(fixture.entry.id)
    const mergedItem = await fixture.db.items.get(fixture.entry.id)
    expect(mergedItem?.notes).toBe('local pending')
    expect(mergedItem?.title).toBe('Server title')
    expect(server.pulls).toBeGreaterThan(1)
    await fixture.db.entries.put({ ...merged!, id: 'purged-entry', collection_id: fixture.collection.id })
    await fixture.db.collections.put({ ...fixture.collection, id: 'removed-collection', server_revision: 1 })
    await fixture.db.entries.put({ ...merged!, id: 'removed-child', collection_id: 'removed-collection' })
    server.pushChange({ entity: 'entry', id: 'purged-entry', purged: true })
    server.pushChange({ entity: 'collection', id: 'removed-collection', removed: true })
    await fixture.engine.syncNow()
    expect(await fixture.db.entries.get('purged-entry')).toBeUndefined()
    expect(await fixture.db.collections.get('removed-collection')).toBeUndefined()
    expect(await fixture.db.entries.get('removed-child')).toBeUndefined()
    await fixture.db.delete()
  })

  it('enters signed_out on 401 and sends no sync requests until the session is authenticated again', async () => {
    const server = new MemoryServer()
    const name = dbName()
    const repo = makeRepo(name)
    const collection = await repo.createCollection({ name: 'Room', storage_mode: 'synced' })
    server.unauthorizedBatch = true
    const engine = makeEngine(name, server)
    await engine.syncNow()
    expect(await waitForStatus(engine, (value) => value.phase === 'signed_out')).toMatchObject({
      phase: 'signed_out',
      authenticated: false,
    })
    const before = server.requests.length
    await engine.syncNow()
    expect(server.requests.slice(before)).toEqual([])
    await server.fetch('/api/auth/login', { method: 'POST' })
    window.dispatchEvent(new Event('capture:authenticated'))
    server.unauthorizedBatch = false
    await engine.syncNow()
    expect(server.records.has(server.key('collection', collection.id))).toBe(true)
    await getCaptureDb(name).delete()
  })

  it('stops requests for a collection switched to Local Only, including later photo writes', async () => {
    const server = new MemoryServer()
    const fixture = await syncedEntry(server)
    await fixture.repo.setStorageMode(fixture.collection.id, 'local_only', { consentToUploadExisting: false })
    const afterSwitch = server.requests.length
    await fixture.repo.updateEntry(fixture.entry.id, { notes: 'local only now' })
    await addPhoto(fixture.repo, fixture.entry.id)
    await fixture.engine.syncNow()
    const later = server.requests.slice(afterSwitch)
    expect(
      later.some(
        (request) =>
          JSON.stringify(request).includes(fixture.collection.id) ||
          JSON.stringify(request).includes(fixture.entry.id),
      ),
    ).toBe(false)
    expect(later.some((request) => request.url.includes('/api/sync/batch'))).toBe(false)
    await fixture.db.delete()
  })

  it('stops at a 507 and resumes immediately on Sync Now', async () => {
    const server = new MemoryServer()
    const fixture = await syncedEntry(server)
    const photo = await addPhoto(fixture.repo, fixture.entry.id)
    const second = await addPhoto(fixture.repo, fixture.entry.id)
    server.storageLow = true
    await fixture.engine.syncNow()
    expect(await fixture.db.outbox.where('collection_id').equals(fixture.collection.id).count()).toBe(0)
    expect(server.records.has(server.key('photo', photo.id))).toBe(true)
    expect(server.requests.some((request) => request.url.startsWith('/api/sync/changes'))).toBe(true)
    expect(await fixture.db.photos.get(photo.id)).toMatchObject({ upload_state: 'error' })
    expect(
      (await waitForStatus(fixture.engine, (value) => value.last_error === 'Server storage is low'))
        .last_error,
    ).toBe('Server storage is low')
    expect(server.requests.at(-1)).toMatchObject({ url: `/api/photos/${photo.id}/original`, method: 'PUT' })
    expect((await fixture.db.photos.get(second.id))?.upload_state).toBe('pending')
    server.storageLow = false
    await fixture.engine.syncNow()
    expect(
      server.requests.filter((request) => request.url.endsWith('/original') && request.method === 'PUT'),
    ).toHaveLength(3)
    expect((await fixture.db.photos.get(photo.id))?.upload_state).toBe('uploaded')
    expect((await fixture.db.photos.get(second.id))?.upload_state).toBe('uploaded')
    await fixture.db.delete()
  })

  it('resumes uploads on a scheduled cycle after the storage backoff expires', async () => {
    const server = new MemoryServer()
    const fixture = await syncedEntry(server)
    const photo = await addPhoto(fixture.repo, fixture.entry.id)
    const other = await addPhoto(fixture.repo, fixture.entry.id)
    server.storageLow = true
    await fixture.engine.runScheduledCycle()
    server.storageLow = false
    const restarted = makeEngine(fixture.name, server)
    fixedNow.value = new Date(clock().getTime() + 299_000)
    await restarted.runScheduledCycle()
    expect(server.stored.size).toBe(0)
    fixedNow.value = new Date(clock().getTime() + 1_000)
    await restarted.runScheduledCycle()
    expect(server.stored.has(photo.id)).toBe(true)
    expect(server.stored.has(other.id)).toBe(true)
    expect((await fixture.db.photos.get(photo.id))?.upload_state).toBe('uploaded')
    await fixture.db.delete()
  })

  it('leaves a cover deleted after one delete and pulls the new cover', async () => {
    const server = new MemoryServer()
    const fixture = await syncedEntry(server)
    const cover = await addPhoto(fixture.repo, fixture.entry.id)
    const next = await addPhoto(fixture.repo, fixture.entry.id)
    await fixture.engine.syncNow()
    await fixture.repo.deletePhoto(cover.id)
    expect(
      await fixture.db.outbox.where('[entity+entity_id]').equals(['photo', cover.id]).first(),
    ).toMatchObject({
      op: 'delete',
      fields: { is_cover: false, deleted_at: expect.any(String) },
    })
    await fixture.engine.syncNow()
    expect(await fixture.db.outbox.count()).toBe(0)
    expect(server.records.get(server.key('photo', cover.id))).toMatchObject({
      deleted_at: expect.any(String),
      is_cover: false,
    })
    expect(await fixture.db.photos.get(cover.id)).toMatchObject({
      deleted_at: expect.any(String),
      is_cover: false,
    })
    expect(await fixture.db.photos.get(next.id)).toMatchObject({ deleted_at: null, is_cover: true })
    await fixture.db.delete()
  })

  it('creates offline entries and photos with their tombstones and backs up the original in trash', async () => {
    const server = new MemoryServer()
    const name = dbName()
    const repo = makeRepo(name)
    const db = getCaptureDb(name)
    const collection = await repo.createCollection({ name: 'Room', storage_mode: 'synced' })
    const entry = await repo.createEntry(collection.id)
    const photo = await addPhoto(repo, entry.id)
    await repo.deletePhoto(photo.id)
    await repo.deleteEntry(entry.id)
    for (const [entity, id] of [
      ['entry', entry.id],
      ['photo', photo.id],
    ]) {
      expect(await db.outbox.where('[entity+entity_id]').equals([entity!, id!]).first()).toMatchObject({
        op: 'upsert',
        base_revision: null,
        fields: { deleted_at: expect.any(String), created_at: expect.any(String) },
      })
    }
    await makeEngine(name, server).syncNow()
    expect(await db.outbox.count()).toBe(0)
    expect(server.records.get(server.key('entry', entry.id))?.deleted_at).toEqual(expect.any(String))
    expect(server.records.get(server.key('photo', photo.id))?.deleted_at).toEqual(expect.any(String))
    expect(server.stored.has(photo.id)).toBe(true)
    expect((await db.photos.get(photo.id))?.upload_state).toBe('uploaded')
    await db.delete()
  })

  it('preserves both sides of an offline move undo, including the new placement in trash', async () => {
    const server = new MemoryServer()
    const { db, repo, engine, entry } = await syncedEntry(server)
    const target = await repo.createCollection({ name: 'Shelf', storage_mode: 'synced' })
    await repo.updateEntry(entry.id, { quantity: '8', entry_notes: 'Initial note' })
    await engine.syncNow()
    const move = await repo.moveEntryPart(target.id, entry.id, '3')
    await repo.undoMove(move.undo)
    await engine.syncNow()
    expect(await db.outbox.count()).toBe(0)
    expect(server.records.get(server.key('entry', entry.id))).toMatchObject({
      quantity: '8',
      deleted_at: null,
      entry_notes: 'Initial note',
    })
    expect(server.records.get(server.key('entry', move.created[0]!.id))).toMatchObject({
      quantity: '3',
      deleted_at: expect.any(String),
    })
    await db.delete()
  })

  it('undoes an acknowledged move using the current server revision', async () => {
    const server = new MemoryServer()
    const { db, repo, engine, entry } = await syncedEntry(server)
    const target = await repo.createCollection({ name: 'Shelf', storage_mode: 'synced' })
    await repo.updateEntry(entry.id, { quantity: '8', entry_notes: 'Initial note' })
    await engine.syncNow()
    const move = await repo.moveEntries(target.id, [entry.id])
    await engine.syncNow()
    expect(server.records.get(server.key('entry', entry.id))?.deleted_at).toEqual(expect.any(String))
    await repo.undoMove(move.undo)
    await engine.syncNow()
    expect(await db.conflicts.count()).toBe(0)
    expect(await db.outbox.count()).toBe(0)
    expect(server.records.get(server.key('entry', entry.id))).toMatchObject({
      quantity: '8',
      deleted_at: null,
      entry_notes: 'Initial note',
    })
    expect(server.records.get(server.key('entry', move.created[0]!.id))?.deleted_at).toEqual(
      expect.any(String),
    )
    await db.delete()
  })

  it('keeps a purge behind the soft delete that makes it eligible', async () => {
    const server = new MemoryServer()
    const { db, repo, collection, entry } = await syncedEntry(server)
    await repo.deleteEntry(entry.id)
    const deleted = (await db.entries.get(entry.id))!
    await db.transaction('rw', db.outbox, () =>
      queueMutation(db, collection, 'entry', deleted, 'purge', {}, clock().toISOString()),
    )
    const queued = await db.outbox.where('[entity+entity_id]').equals(['entry', entry.id]).toArray()
    expect(queued.map(({ op }) => op)).toEqual(['delete', 'purge'])
    expect(queued[0]?.fields).toMatchObject({ deleted_at: expect.any(String) })
    expect(queued[1]?.fields).toEqual({})
    await db.delete()
  })

  it('rebases a lifecycle change behind a sent create even when sequence allocation is retried', async () => {
    const server = new MemoryServer()
    const fixture = await syncedEntry(server)
    const entry = await fixture.repo.createEntry(fixture.collection.id)
    server.records.set('entry:taken-entry', {
      id: 'taken-entry',
      collection_id: fixture.collection.id,
      sequence_number: entry.sequence_number,
      revision: 1,
      field_revisions: {},
    })
    const batch = holdBatch(server)
    const engine = makeEngine(fixture.name, server)
    const first = engine.syncNow()
    await batch.entered
    try {
      await fixture.repo.deleteEntry(entry.id)
      await fixture.repo.updateEntry(entry.id, { quantity: '7' })
    } finally {
      batch.release()
    }
    await first
    await engine.syncNow()
    await engine.syncNow()
    expect(server.records.get(server.key('entry', entry.id))).toMatchObject({
      deleted_at: expect.any(String),
      quantity: '7',
    })
    expect(server.records.get(server.key('entry', entry.id))?.sequence_number).toBeGreaterThan(
      entry.sequence_number,
    )
    expect(await fixture.db.conflicts.count()).toBe(0)
    expect(await fixture.db.outbox.count()).toBe(0)
    await fixture.db.delete()
  })

  it('replays my photo deletion when resolving a deleted_at conflict and keeps the merged caption', async () => {
    const server = new MemoryServer()
    const fixture = await syncedEntry(server)
    const photo = await addPhoto(fixture.repo, fixture.entry.id)
    await fixture.engine.syncNow()
    server.externalUpdate('photo', photo.id, { deleted_at: '2026-01-01T00:00:00.000Z' })
    await fixture.repo.deletePhoto(photo.id)
    await fixture.repo.updatePhoto(photo.id, { caption: 'Keep this caption' })
    await fixture.engine.syncNow()
    const conflict = await fixture.db.conflicts
      .where('[entity+entity_id]')
      .equals(['photo', photo.id])
      .first()
    expect(conflict).toMatchObject({ fields: ['deleted_at'] })
    await fixture.engine.resolveConflict(conflict!.id, 'mine')
    await fixture.engine.syncNow()
    await waitFor(async () => (await fixture.db.outbox.count()) === 0)
    const last = server.batchRequests
      .flat()
      .filter((row) => row.entity_id === photo.id)
      .at(-1)
    expect(last).toMatchObject({ op: 'delete', fields: { deleted_at: expect.any(String) } })
    expect(server.records.get(server.key('photo', photo.id))).toMatchObject({
      deleted_at: expect.any(String),
      caption: 'Keep this caption',
    })
    expect(await fixture.db.conflicts.count()).toBe(0)
    await fixture.db.delete()
  })

  it('replays my restore when another device changed the tombstone', async () => {
    const server = new MemoryServer()
    const fixture = await syncedEntry(server)
    await fixture.repo.deleteEntry(fixture.entry.id)
    await fixture.engine.syncNow()
    server.externalUpdate('entry', fixture.entry.id, { deleted_at: '2026-01-01T00:00:00.000Z' })
    await fixture.repo.restoreEntry(fixture.entry.id)
    await fixture.engine.syncNow()
    const conflict = await fixture.db.conflicts
      .where('[entity+entity_id]')
      .equals(['entry', fixture.entry.id])
      .first()
    expect(conflict).toMatchObject({ fields: ['deleted_at'], local_values: { deleted_at: null } })
    await fixture.engine.resolveConflict(conflict!.id, 'mine')
    await fixture.engine.syncNow()
    expect(server.batchRequests.at(-1)?.[0]).toMatchObject({ op: 'restore', fields: { deleted_at: null } })
    expect(server.records.get(server.key('entry', fixture.entry.id))?.deleted_at).toBeNull()
    expect(await fixture.db.conflicts.count()).toBe(0)
    await fixture.db.delete()
  })

  it('rotates a legacy mutation id if the server reveals a previously lost rejection', async () => {
    const server = new MemoryServer()
    const fixture = await syncedEntry(server)
    const entry = await fixture.repo.createEntry(fixture.collection.id)
    await fixture.repo.deleteEntry(entry.id)
    const original = (await fixture.db.outbox
      .where('[entity+entity_id]')
      .equals(['entry', entry.id])
      .first())!
    const malformed = {
      ...original,
      op: 'delete' as const,
      fields: { deleted_at: original.fields.deleted_at },
    }
    expect(server.applyMutation(malformed)).toMatchObject({ status: 'rejected', code: 'missing_parent' })
    await fixture.db.outbox.put({ ...malformed, sent: true })
    await fixture.engine.syncNow()
    const repaired = await fixture.db.outbox.where('[entity+entity_id]').equals(['entry', entry.id]).first()
    expect(repaired).toMatchObject({ op: 'upsert', sent: false, base_revision: null })
    expect(repaired?.id).not.toBe(original.id)
    await fixture.engine.syncNow()
    expect(server.records.get(server.key('entry', entry.id))?.deleted_at).toEqual(expect.any(String))
    expect(await fixture.db.outbox.count()).toBe(0)
    await fixture.db.delete()
  })

  it('repairs old queued tombstones and rejected creates idempotently without transmitting mixed-mode items', async () => {
    const server = new MemoryServer()
    const fixture = await syncedEntry(server)
    const legacyPhoto = await addPhoto(fixture.repo, fixture.entry.id)
    await fixture.engine.syncNow()
    server.stored.delete(legacyPhoto.id)
    await fixture.repo.deletePhoto(legacyPhoto.id)
    const oldDelete = (await fixture.db.outbox
      .where('[entity+entity_id]')
      .equals(['photo', legacyPhoto.id])
      .first())!
    await fixture.db.outbox.update(oldDelete.id, { op: 'upsert' })
    await fixture.db.photos.update(legacyPhoto.id, { upload_state: 'not_needed' })

    const newEntry = await fixture.repo.createEntry(fixture.collection.id)
    await fixture.repo.deleteEntry(newEntry.id)
    const oldCreate = (await fixture.db.outbox
      .where('[entity+entity_id]')
      .equals(['entry', newEntry.id])
      .first())!
    const malformed = {
      ...oldCreate,
      op: 'delete' as const,
      fields: { deleted_at: oldCreate.fields.deleted_at },
    }
    server.applyMutation(malformed)
    await fixture.db.outbox.put({
      ...malformed,
      sent: true,
      attempts: 1,
      last_error: 'Record does not exist',
    })
    const unsentEntry = await fixture.repo.createEntry(fixture.collection.id)
    await fixture.repo.deleteEntry(unsentEntry.id)
    const unsent = (await fixture.db.outbox
      .where('[entity+entity_id]')
      .equals(['entry', unsentEntry.id])
      .first())!
    await fixture.db.outbox.update(unsent.id, {
      op: 'delete',
      fields: { deleted_at: unsent.fields.deleted_at },
    })

    const mixed = await fixture.repo.createEntry(fixture.collection.id)
    const privateCollection = await fixture.repo.createCollection({
      name: 'Private',
      storage_mode: 'local_only',
    })
    const privateEntry = await fixture.repo.createEntry(privateCollection.id)
    const mixedPhoto = await addPhoto(fixture.repo, mixed.id)
    await fixture.db.entries.update(privateEntry.id, {
      item_id: mixed.item_id,
      deleted_at: clock().toISOString(),
    })
    await fixture.db.photos.update(mixedPhoto.id, { server_revision: 1, upload_state: 'not_needed' })

    await repairSyncQueue(fixture.db)
    const repairedRows = await fixture.db.outbox.toArray()
    await repairSyncQueue(fixture.db)
    expect(await fixture.db.outbox.toArray()).toEqual(repairedRows)
    expect(await fixture.db.outbox.get(oldDelete.id)).toMatchObject({ op: 'delete' })
    expect(await fixture.db.outbox.get(oldCreate.id)).toBeUndefined()
    expect(await fixture.db.outbox.get(unsent.id)).toMatchObject({
      op: 'upsert',
      fields: { deleted_at: expect.any(String), sequence_number: unsentEntry.sequence_number },
    })
    expect(await fixture.db.photos.get(mixedPhoto.id)).toMatchObject({ upload_state: 'not_needed' })
    const repaired = repairedRows.find((row) => row.entity === 'entry' && row.entity_id === newEntry.id)
    expect(repaired).toMatchObject({
      op: 'upsert',
      sent: false,
      base_revision: null,
      fields: { sequence_number: newEntry.sequence_number },
    })
    const before = server.requests.length
    await fixture.engine.syncNow()
    expect(server.records.get(server.key('entry', newEntry.id))?.deleted_at).toEqual(expect.any(String))
    expect(server.records.get(server.key('photo', legacyPhoto.id))?.deleted_at).toEqual(expect.any(String))
    expect(server.stored.has(legacyPhoto.id)).toBe(true)
    expect(JSON.stringify(server.requests.slice(before))).not.toContain(mixedPhoto.id)
    expect(JSON.stringify(server.requests.slice(before))).not.toContain(mixed.item_id)
    await fixture.db.delete()
  })

  it('repairs stale uploads without writing unchanged photo rows', async () => {
    const server = new MemoryServer()
    const { db, repo, entry, engine } = await syncedEntry(server)
    const unchanged = await addPhoto(repo, entry.id)
    const stale = await addPhoto(repo, entry.id)
    await engine.syncNow()
    await db.photos.update(stale.id, { upload_state: 'uploading' })
    const touched: Id[] = []
    const onUpdate = (_changes: unknown, key: Id) => {
      touched.push(key)
    }
    db.photos.hook('updating', onUpdate)

    await repairSyncQueue(db)
    await repairSyncQueue(db)

    expect(touched).toEqual([stale.id])
    expect(await db.photos.get(unchanged.id)).toMatchObject({ upload_state: 'uploaded' })
    expect(await db.photos.get(stale.id)).toMatchObject({ upload_state: 'pending' })
    db.photos.hook('updating').unsubscribe(onUpdate)
    await db.delete()
  })

  it('uploads deleted photos when opting in and queues an older unbacked photo on undo', async () => {
    const server = new MemoryServer()
    const name = dbName()
    const db = getCaptureDb(name)
    const repo = makeRepo(name)
    const collection = await repo.createCollection({ name: 'Room', storage_mode: 'local_only' })
    const entry = await repo.createEntry(collection.id)
    const trash = await addPhoto(repo, entry.id)
    await repo.deletePhoto(trash.id)
    const engine = makeEngine(name, server)
    await engine.syncNow()
    expect(JSON.stringify(server.requests)).not.toContain(trash.id)

    await repo.setStorageMode(collection.id, 'synced', { consentToUploadExisting: true })
    expect(await db.photos.get(trash.id)).toMatchObject({
      upload_state: 'pending',
      deleted_at: expect.any(String),
    })
    await engine.syncNow()
    expect(server.stored.has(trash.id)).toBe(true)
    expect(await db.photos.get(trash.id)).toMatchObject({
      upload_state: 'uploaded',
      deleted_at: expect.any(String),
    })

    server.stored.delete(trash.id)
    await db.photos.update(trash.id, { upload_state: 'not_needed' })
    await repo.restorePhoto(trash.id)
    expect(await db.photos.get(trash.id)).toMatchObject({ upload_state: 'pending', deleted_at: null })
    await engine.syncNow()
    expect(await db.photos.get(trash.id)).toMatchObject({ upload_state: 'uploaded', deleted_at: null })
    await db.delete()
  })

  it('pushes edits and pulls changes between photo uploads', async () => {
    const server = new MemoryServer()
    const fixture = await syncedEntry(server)
    const first = await addPhoto(fixture.repo, fixture.entry.id)
    const second = await addPhoto(fixture.repo, fixture.entry.id)
    const third = await addPhoto(fixture.repo, fixture.entry.id)
    let release!: () => void
    let reached!: () => void
    const entered = new Promise<void>((resolve) => (reached = resolve))
    const gate = new Promise<void>((resolve) => (release = resolve))
    const originalFetch = server.fetch
    server.fetch = async (input, init = {}) => {
      const response = await originalFetch(input, init)
      if (String(input) === `/api/photos/${first.id}/original` && init.method === 'PUT') {
        reached()
        await gate
      }
      return response
    }
    const engine = makeEngine(fixture.name, server)
    const syncing = engine.syncNow()
    await entered
    try {
      await fixture.repo.updateEntry(fixture.entry.id, { quantity: '10' })
    } finally {
      release()
    }
    await syncing
    const uploadIndices = [first, second, third].map((photo) =>
      server.requests.findIndex(
        (request) => request.method === 'PUT' && request.url === `/api/photos/${photo.id}/original`,
      ),
    )
    expect(uploadIndices[0]).toBeGreaterThanOrEqual(0)
    expect(uploadIndices[1]).toBeGreaterThan(uploadIndices[0]!)
    expect(uploadIndices[2]).toBeGreaterThan(uploadIndices[1]!)
    expect(
      server.requests
        .slice(uploadIndices[0]! + 1, uploadIndices[1])
        .some(({ url, body }) => url === '/api/sync/batch' && String(body).includes('"quantity":"10"')),
    ).toBe(true)
    expect(
      server.requests
        .slice(uploadIndices[1]! + 1, uploadIndices[2])
        .some(({ url }) => url.startsWith('/api/sync/changes')),
    ).toBe(true)
    expect(
      server.requests.filter(({ url, method }) => url.endsWith('/original') && method === 'PUT'),
    ).toHaveLength(3)
    await fixture.db.delete()
  })

  it('stops the cycle when an upload returns 401', async () => {
    const server = new MemoryServer()
    const fixture = await syncedEntry(server)
    const first = await addPhoto(fixture.repo, fixture.entry.id)
    const second = await addPhoto(fixture.repo, fixture.entry.id)
    const fetch = server.fetch
    server.fetch = async (input, init) => {
      if (String(input) === `/api/photos/${first.id}/original` && init?.method === 'PUT') {
        server.requests.push({ url: String(input), method: 'PUT' })
        return new Response(null, { status: 401 })
      }
      return fetch(input, init)
    }
    const engine = makeEngine(fixture.name, server)
    await engine.syncNow()
    expect(server.requests.at(-1)).toMatchObject({ method: 'PUT', url: `/api/photos/${first.id}/original` })
    expect((await fixture.db.photos.get(first.id))?.upload_state).toBe('pending')
    expect((await fixture.db.photos.get(second.id))?.upload_state).toBe('pending')
    expect((await waitForStatus(engine, (value) => value.phase === 'signed_out')).authenticated).toBe(false)
    await fixture.db.delete()
  })

  it('does not send original bytes when a photo becomes Local Only during its HEAD request', async () => {
    const server = new MemoryServer()
    const fixture = await syncedEntry(server)
    const photo = await addPhoto(fixture.repo, fixture.entry.id)
    const fetch = server.fetch
    server.fetch = async (input, init) => {
      const response = await fetch(input, init)
      if (String(input) === `/api/photos/${photo.id}/original` && init?.method === 'HEAD') {
        await fixture.repo.setStorageMode(fixture.collection.id, 'local_only', {
          consentToUploadExisting: false,
        })
      }
      return response
    }
    await makeEngine(fixture.name, server).syncNow()
    expect(server.requests.filter(({ url, method }) => url.includes(photo.id) && method === 'PUT')).toEqual(
      [],
    )
    expect(await fixture.db.photos.get(photo.id)).toMatchObject({
      upload_state: 'not_needed',
      sync_state: 'local_only',
    })
    await fixture.db.delete()
  })

  it('surfaces missing originals and still backs up the next photo', async () => {
    const server = new MemoryServer()
    const fixture = await syncedEntry(server)
    const missing = await addPhoto(fixture.repo, fixture.entry.id)
    const next = await addPhoto(fixture.repo, fixture.entry.id)
    await fixture.db.photoBlobs.delete(missing.id)
    await fixture.engine.syncNow()
    expect(await fixture.db.photos.get(missing.id)).toMatchObject({ upload_state: 'error' })
    expect(await fixture.db.photos.get(next.id)).toMatchObject({ upload_state: 'uploaded' })
    expect(server.stored.has(missing.id)).toBe(false)
    await fixture.engine.runScheduledCycle()
    expect((await waitForStatus(fixture.engine, (status) => !!status.last_error)).last_error).toBe(
      'The original photo is missing from this device.',
    )
    await fixture.db.delete()
  })
})

function holdBatch(server: MemoryServer) {
  let reached!: () => void
  let release!: () => void
  const entered = new Promise<void>((resolve) => (reached = resolve))
  const gate = new Promise<void>((resolve) => (release = resolve))
  const fetch = server.fetch
  let held = false
  server.fetch = async (input, init) => {
    const response = await fetch(input, init)
    if (!held && String(input) === '/api/sync/batch') {
      held = true
      reached()
      await gate
    }
    return response
  }
  return { entered, release }
}

describe.each(['queued', 'in flight', 'acknowledged'] as const)(
  'entry lifecycle with the first operation %s',
  (timing) => {
    it.each([
      ['delete', 'edit'],
      ['restore', 'edit'],
      ['delete', 'restore'],
      ['restore', 'delete'],
      ['edit', 'delete'],
      ['edit', 'restore'],
    ] as const)('preserves %s followed by %s', async (first, second) => {
      const server = new MemoryServer()
      const { name, repo, db, entry } = await syncedEntry(server)
      const run = {
        delete: () => repo.deleteEntry(entry.id),
        restore: () => repo.restoreEntry(entry.id),
        edit: () => repo.updateEntry(entry.id, { quantity: '4' }),
      }
      const shouldStartDeleted = first === 'restore' || (first === 'edit' && second === 'restore')
      if (shouldStartDeleted) {
        await run.delete()
        await makeEngine(name, server).syncNow()
      }
      const batch = timing === 'in flight' ? holdBatch(server) : undefined
      const engine = makeEngine(name, server)
      await run[first]()
      const syncing = timing === 'queued' ? undefined : engine.syncNow()
      if (batch) await batch.entered
      else await syncing
      try {
        await run[second]()
      } finally {
        batch?.release()
      }
      await syncing
      await engine.syncNow()
      expect(await db.outbox.count()).toBe(0)
      expect(await db.conflicts.count()).toBe(0)
      const finalLifecycle = second === 'edit' ? first : second
      const record = {
        deleted_at: finalLifecycle === 'delete' ? expect.any(String) : null,
        ...(first === 'edit' || second === 'edit' ? { quantity: '4' } : {}),
      }
      expect(server.records.get(server.key('entry', entry.id))).toMatchObject(record)
      expect(await db.entries.get(entry.id)).toMatchObject(record)
      await db.delete()
    })
  },
)

async function waitForStatus(
  engine: ReturnType<typeof createSyncEngine>,
  predicate: (value: import('./api').SyncStatus) => boolean,
) {
  let value: import('./api').SyncStatus | undefined
  const subscription = engine.status.subscribe((next) => {
    value = next
  })
  await waitFor(async () => !!value && predicate(value))
  if (typeof subscription === 'function') subscription()
  else subscription.unsubscribe()
  return value!
}

it('replays movements behind an upgraded cursor without replaying old removals or unknown entities', async () => {
  const server = new MemoryServer()
  const { repo, engine, db, collection, entry } = await syncedEntry(server)
  const target = await repo.createCollection({ name: 'Other', storage_mode: 'synced' })
  await repo.updateEntry(entry.id, { quantity: '10' })
  const moved = await repo.moveEntryPart(target.id, entry.id, '2.50')
  await engine.syncNow()
  const id = moved.undo.movement_ids[0]!
  const initial = await db.movements.get(id)
  expect(initial).toMatchObject({ kind: 'part', quantity: '2.50', sync_state: 'synced' })
  await db.movements.delete(id)
  await repo.updateEntry(entry.id, { entry_notes: 'pending note that overlaps old removed record' })
  const queued = await db.outbox.toArray()
  const conflict = {
    id: 'conflict-before-upgrade',
    collection_id: collection.id,
    entity: 'entry' as const,
    entity_id: entry.id,
    fields: ['entry_notes'],
    local_values: { entry_notes: 'pending note that overlaps old removed record' },
    server_values: { entry_notes: 'from server' },
    server_revision: 1,
    created_at: clock().toISOString(),
  }
  await db.conflicts.add(conflict)
  const removedSeq = server.changes.at(-1)!.seq + 1
  server.changes.push({ seq: removedSeq, entity: 'collection', id: collection.id, removed: true })
  const future = {
    seq: removedSeq + 1,
    entity: 'future-type' as OutboxEntity,
    id: 'future',
    record: {
      id: 'future',
      revision: 1,
      field_revisions: {},
    },
  }
  server.changes.push(future)
  await db.settings.put({ key: 'sync_schema2_cursor', value: removedSeq })
  await db.settings.put({ key: 'sync_cursor', value: 0 })

  await engine.syncNow()
  expect(server.requests.some(({ url }) => url.includes('cursor=0&') && url.includes('schema=3'))).toBe(true)
  expect(await db.movements.get(id)).toMatchObject({ kind: 'part', quantity: '2.50', undone_at: null })
  expect(await db.photos.get('future')).toBeUndefined()
  expect(await db.outbox.toArray()).toEqual(queued)
  expect(await db.conflicts.toArray()).toEqual([conflict])
  expect((await db.collections.get(collection.id))?.removed_on_server).toBeUndefined()
  expect((await db.settings.get('sync_cursor'))?.value).toBe(future.seq)
  expect(await db.settings.get('sync_schema2_cursor')).toBeUndefined()
  const requests = server.requests.length
  await engine.syncNow()
  expect(server.requests.slice(requests).some(({ url }) => url.includes('cursor=0&'))).toBe(false)
  await db.delete()
})

it('withholds a movement when its historical room becomes Local Only and queues it after consent', async () => {
  const server = new MemoryServer()
  const { repo, engine, db, collection, entry } = await syncedEntry(server)
  const target = await repo.createCollection({ name: 'Other', storage_mode: 'synced' })
  const moved = await repo.moveEntries(target.id, [entry.id])
  const id = moved.undo.movement_ids[0]!
  // Simulate an already-purged source placement while its room and the shared item survive.
  await db.entries.delete(entry.id)
  await repo.setStorageMode(collection.id, 'local_only', { consentToUploadExisting: false })
  expect((await db.movements.get(id))?.sync_state).toBe('local_only')
  expect(await db.outbox.where('[entity+entity_id]').equals(['movement', id]).count()).toBe(0)
  await engine.syncNow()
  expect(server.records.get(server.key('movement', id))).toBeUndefined()
  await repo.setStorageMode(collection.id, 'synced', { consentToUploadExisting: true })
  expect(await db.outbox.where('[entity+entity_id]').equals(['movement', id]).count()).toBe(1)
  await engine.syncNow()
  expect(server.records.get(server.key('movement', id))).toMatchObject({ id, from_entry_id: entry.id })
  await db.delete()
})
