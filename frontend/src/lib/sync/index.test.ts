import { Blob as NodeBlobImpl } from 'node:buffer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createRepo, getCaptureDb } from '../db'
import { createSyncEngine } from './index'

const NodeBlob = NodeBlobImpl as unknown as typeof Blob
let sequence = 0
const databaseName = () => `sync-test-${++sequence}`

function response(status: number, body?: unknown, headers?: HeadersInit): Response {
  return new Response(body === undefined ? null : JSON.stringify(body), { status, headers })
}

afterEach(() => vi.restoreAllMocks())

describe('foreground sync privacy and consent', () => {
  it('never mentions Local Only ids in a request while creating and editing local data', async () => {
    const name = databaseName()
    const repo = createRepo({
      databaseName: name,
      imageProcessor: async () => ({ width: 1, height: 1, thumbnail: new NodeBlob(['thumb']) as Blob }),
    })
    const local = await repo.createCollection({ name: 'Private room', storage_mode: 'local_only' })
    const entry = await repo.createEntry(local.id)
    await repo.updateEntry(entry.id, { notes: 'private note' })
    await repo.addPhotos(entry.id, [
      { blob: new NodeBlob(['original'], { type: 'image/jpeg' }) as Blob, source: 'photo_library' },
    ])
    await repo.deleteEntry(entry.id)

    const requests: string[] = []
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      requests.push(url)
      if (url === '/api/auth/session') return response(200, { authenticated: true, expires_at: null })
      if (url.startsWith('/api/sync/changes'))
        return response(200, { changes: [], cursor: 0, has_more: false })
      return response(200, { results: [] })
    }) as unknown as typeof fetch
    const engine = createSyncEngine({ repoDbName: name, fetch: fetcher })
    await engine.syncNow()

    expect(requests.some((url) => url.includes(local.id) || url.includes(entry.id))).toBe(false)
    expect(fetcher).toHaveBeenCalledTimes(2)
    await getCaptureDb(name).delete()
  })

  it('requires explicit consent and queues existing collection, entry, and photo records', async () => {
    const name = databaseName()
    const repo = createRepo({
      databaseName: name,
      imageProcessor: async () => ({ width: 1, height: 1, thumbnail: new NodeBlob(['thumb']) as Blob }),
    })
    const collection = await repo.createCollection({ name: 'Room A', storage_mode: 'local_only' })
    const entry = await repo.createEntry(collection.id)
    await repo.addPhotos(entry.id, [
      { blob: new NodeBlob(['original'], { type: 'image/jpeg' }) as Blob, source: 'photo_library' },
    ])
    await expect(
      repo.setStorageMode(collection.id, 'synced', { consentToUploadExisting: false }),
    ).rejects.toThrow(/consent/i)
    await repo.setStorageMode(collection.id, 'synced', { consentToUploadExisting: true })

    const db = getCaptureDb(name)
    const queued = await db.outbox.where('collection_id').equals(collection.id).toArray()
    expect(queued.map((item) => item.entity).sort()).toEqual(['collection', 'entry', 'photo'])
    expect((await db.photos.toArray()).every((photo) => photo.upload_state === 'pending')).toBe(true)

    const photos = await db.photos.toArray()
    const calls: string[] = []
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      calls.push(`${init?.method ?? 'GET'} ${url}`)
      if (url === '/api/auth/session') return response(200, { authenticated: true, expires_at: null })
      if (url === '/api/sync/batch') {
        const body = JSON.parse(String(init?.body)) as { mutations: Array<{ id: string }> }
        return response(200, {
          results: body.mutations.map((mutation) => ({
            id: mutation.id,
            status: 'applied',
            server_revision: 1,
            record: {},
          })),
          cursor: 0,
        })
      }
      if (url.endsWith('/original') && init?.method === 'HEAD') return response(404)
      if (url.endsWith('/original') && init?.method === 'PUT') {
        const photo = photos.find((item) => url.includes(item.id))!
        return response(201, {
          photo_id: photo.id,
          sha256: photo.sha256,
          byte_size: photo.byte_size,
          server_storage_key: `key-${photo.id}`,
        })
      }
      if (url.endsWith('/thumbnail')) return response(201)
      if (url.startsWith('/api/sync/changes'))
        return response(200, { changes: [], cursor: 0, has_more: false })
      return response(200)
    }) as unknown as typeof fetch
    const engine = createSyncEngine({ repoDbName: name, fetch: fetcher })
    await engine.syncNow()

    expect(calls.filter((call) => call.includes('/api/sync/batch'))).toHaveLength(1)
    expect((await db.photos.toArray()).every((photo) => photo.upload_state === 'uploaded')).toBe(true)
    expect(await db.outbox.where('collection_id').equals(collection.id).count()).toBe(0)
    await db.delete()
  })
})

describe('sign-in messages', () => {
  it('distinguishes a wrong password, rate limiting and an unreachable server', async () => {
    const { createClients } = await import('./index')
    const wrong = createClients(async () => new Response(null, { status: 401 }))
    await expect(wrong.authClient.login('nope')).rejects.toThrow('Password is incorrect.')
    const limited = createClients(
      async () => new Response(null, { status: 429, headers: { 'Retry-After': '300' } }),
    )
    await expect(limited.authClient.login('x')).rejects.toThrow('Try again in 5 minutes.')
    const offline = createClients(async () => {
      throw new TypeError('Failed to fetch')
    })
    await expect(offline.authClient.login('x')).rejects.toThrow("Couldn't reach the server")
  })
})
