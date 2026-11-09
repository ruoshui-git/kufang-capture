import { Blob as NodeBlobImpl } from 'node:buffer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import Dexie from 'dexie'
import type { Id, OutboxEntity, Photo } from '../types'
import { createRepo, getCaptureDb } from '../db'
import { sha256 } from '../photos'
import { createSyncEngine } from './index'

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
      return new Response(JSON.stringify({ authenticated: this.authenticated, expires_at: null }), {
        status: 200,
      })
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
      ? Object.keys(mutation.fields).filter(
          (field) =>
            (existing.field_revisions[field] ?? 0) > (mutation.base_revision ?? 0) &&
            existing[field] !== mutation.fields[field],
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
    const fields = { ...mutation.fields }
    if (mutation.entity === 'collection' && typeof fields.next_sequence_number === 'number') {
      fields.next_sequence_number = Math.max(
        Number(existing?.next_sequence_number ?? 1),
        fields.next_sequence_number,
      )
    }
    const fieldRevisions = { ...(existing?.field_revisions ?? {}) }
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
      ...(existing ?? {}),
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

function makeEngine(name: string, server: MemoryServer) {
  return createSyncEngine({ repoDbName: name, fetch: server.fetch as unknown as typeof fetch, now: clock })
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
  fixedNow.value = new Date('2026-11-08T12:00:00.000Z')
  vi.restoreAllMocks()
})

describe('sync acceptance against an in-memory API server', () => {
  it('sends schema 2 and keeps the outbox when the server requires an app update', async () => {
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
    expect(JSON.parse(String(batch.body)).schema).toBe(2)
    expect(
      server.requests.some(
        (request) => request.url.includes('/api/sync/changes?') && request.url.includes('schema=2'),
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
    fixedNow.value = new Date(fixedNow.value.getTime() + 10_000)
    await fixture.engine.syncNow()
    const sentIds = server.batchRequests
      .slice(-2)
      .map((batch) => batch.find((item) => item.entity_id === fixture.entry.id)!.id)
    expect(sentIds.at(-1)).toBe(before!.id)
    expect(new Set(sentIds).size).toBe(1)
    expect(server.records.get(server.key('item', fixture.entry.id))?.notes).toBe('retry me')
    expect(server.records.get(server.key('item', fixture.entry.id))).toBeDefined()
    expect(server.records.get(server.key('entry', fixture.entry.id))).toBeDefined()
    expect(await fixture.db.outbox.get(before!.id)).toBeUndefined()
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
    expect((await fixture.db.photos.get(photo.id))?.upload_state).toBe('uploading')
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
    expect(
      (await fixture.db.entries.where('collection_id').equals(fixture.collection.id).toArray()).map(
        (item) => item.sequence_number,
      ),
    ).toContain(entry.sequence_number)
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
    await fixture.db.collections.put({ ...fixture.collection, id: 'removed-collection' })
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

  it('pauses uploads on 507, reports low storage, and continues metadata synchronization', async () => {
    const server = new MemoryServer()
    const fixture = await syncedEntry(server)
    const photo = await addPhoto(fixture.repo, fixture.entry.id)
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
    server.storageLow = false
    await fixture.engine.syncNow()
    expect(
      server.requests.filter((request) => request.url.endsWith('/original') && request.method === 'PUT'),
    ).toHaveLength(1)
    await fixture.db.delete()
  })
})

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
