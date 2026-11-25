import { Blob as NodeBlobImpl } from 'node:buffer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createRepo, getCaptureDb } from '../db'
import { SETTING_KEYS } from '../types'
import type { SessionUser } from './api'
import { AccountGate } from './binding'

const owner = { id: 'owner', name: 'Owner', is_owner: true }
const helper = { id: 'helper', name: 'Mina', is_owner: false }
const NodeBlob = NodeBlobImpl as unknown as typeof Blob
let dbName: string
let sequence = 0

function fixture() {
  dbName = `test-binding-${++sequence}`
  return {
    gate: new AccountGate(dbName),
    db: getCaptureDb(dbName),
    repo: createRepo({
      databaseName: dbName,
      imageProcessor: async () => ({ width: 1, height: 1, thumbnail: new NodeBlob(['thumb']) }),
    }),
  }
}

function session(user: SessionUser | null) {
  return Response.json({ authenticated: user !== null, user, expires_at: null })
}

afterEach(async () => {
  if (dbName) await getCaptureDb(dbName).delete()
})

describe('device binding', () => {
  it('upgrades an owner device with synced data and preserves its cursor and queue', async () => {
    const { gate, repo, db } = fixture()
    await repo.createCollection({ name: 'Old synced collection', storage_mode: 'synced' })
    await repo.setSetting(SETTING_KEYS.syncCursor, 123)
    const queue = await db.outbox.toArray()
    expect(queue.length).toBeGreaterThan(0)
    await expect(gate.check(async () => session(owner))).resolves.toEqual({ kind: 'ready', user: owner })
    expect(await repo.getSetting('account_id', null)).toBe('owner')
    expect(await repo.getSetting('account_name', null)).toBe('Owner')
    expect(await repo.getSetting(SETTING_KEYS.syncCursor, 0)).toBe(123)
    expect(await db.outbox.toArray()).toEqual(queue)
  })

  it('keeps Local Only data and resets the cursor only when an empty sync device is switched', async () => {
    const { gate, repo, db } = fixture()
    const collection = await repo.createCollection({ name: 'Private', storage_mode: 'local_only' })
    const entry = await repo.createEntry(collection.id)
    const initialCollection = await db.collections.get(collection.id)
    const initialEntry = await db.entries.get(entry.id)
    await gate.check(async () => session(owner))
    await repo.setSetting(SETTING_KEYS.syncCursor, 123)

    await expect(gate.check(async () => session(helper))).resolves.toMatchObject({
      kind: 'blocked',
      canSwitch: true,
      name: 'Owner',
      user: helper,
    })
    expect(await repo.getSetting('account_id', null)).toBe(owner.id)
    expect(await repo.getSetting(SETTING_KEYS.syncCursor, 0)).toBe(123)

    await expect(gate.check(async () => session(helper), undefined, true)).resolves.toEqual({
      kind: 'ready',
      user: helper,
    })
    expect(await repo.getSetting('account_id', null)).toBe(helper.id)
    expect(await repo.getSetting(SETTING_KEYS.syncCursor, -1)).toBe(0)
    expect(await repo.getSetting(SETTING_KEYS.lastStorageMode, 'local_only')).toBe('synced')
    expect(await db.collections.get(collection.id)).toEqual(initialCollection)
    expect(await db.entries.get(entry.id)).toEqual(initialEntry)
  })

  it.each([false, true])(
    'refuses a helper on a legacy or bound device with only synced metadata (bound=%s)',
    async (bound) => {
      const { gate, repo, db } = fixture()
      const collection = await repo.createCollection({ name: 'Synced', storage_mode: 'synced' })
      await db.outbox.clear()
      if (bound) await gate.check(async () => session(owner))
      const helperFetch = vi.fn(async () => session(helper))
      await expect(gate.check(helperFetch, undefined, true)).resolves.toMatchObject({
        kind: 'blocked',
        name: 'Owner',
        canSwitch: false,
      })
      await expect(gate.request(helperFetch, '/api/exports/all.zip')).rejects.toThrow('belongs to Owner')
      expect(helperFetch).toHaveBeenCalledTimes(1)
      expect(await repo.getSetting('account_id', null)).toBe(bound ? owner.id : null)
      expect(await db.collections.get(collection.id)).toEqual(collection)
    },
  )

  it('refuses to switch while an outbox exists even when no synced collections remain', async () => {
    const { gate, repo, db } = fixture()
    await gate.check(async () => session(owner))
    const stale = await repo.createCollection({ name: 'Stale', storage_mode: 'synced' })
    await db.collections.delete(stale.id)
    const queue = await db.outbox.toArray()
    expect(queue).not.toHaveLength(0)
    await expect(gate.check(async () => session(helper), undefined, true)).resolves.toMatchObject({
      kind: 'blocked',
      canSwitch: false,
    })
    expect(await repo.getSetting('account_id', null)).toBe(owner.id)
    expect(await db.outbox.toArray()).toEqual(queue)
  })

  it('allows a helper to bind after a fresh sign-in on a device without synced data', async () => {
    const { gate, repo } = fixture()
    await expect(gate.check(async () => session(null))).resolves.toEqual({ kind: 'signed_out' })
    expect(await repo.getSetting('account_id', null)).toBeNull()
    await expect(gate.check(async () => session(helper))).resolves.toEqual({ kind: 'ready', user: helper })
    expect(await repo.getSetting(SETTING_KEYS.lastStorageMode, 'local_only')).toBe('synced')
  })

  it('blocks immediately when a data request sees a changed cookie and starts no more requests', async () => {
    const { gate } = fixture()
    const fetcher = vi.fn(async (input: RequestInfo | URL) =>
      input === '/api/auth/session'
        ? session(helper)
        : Response.json({ detail: 'account_mismatch' }, { status: 409 }),
    )
    await expect(gate.request(fetcher, '/api/collections')).rejects.toThrow('belongs to Mina')
    await expect(gate.request(fetcher, '/api/exports/all.zip')).rejects.toThrow('belongs to Mina')
    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(gate.current).toMatchObject({ kind: 'blocked', user: null })
  })

  it('keeps the blocked state when an older session probe returns late', async () => {
    const { gate } = fixture()
    await gate.check(async () => session(owner))
    let finishProbe!: (response: Response) => void
    const delayedProbe = gate.check(() => new Promise((resolve) => (finishProbe = resolve)))
    const rejected = expect(delayedProbe).rejects.toMatchObject({ name: 'AbortError' })
    await gate.check(async () => session(helper))
    finishProbe(session(owner))
    await rejected
    expect(gate.current).toMatchObject({ kind: 'blocked', name: 'Owner', user: helper })
  })

  it('uses the account header, a no-store fetch, and CSRF protection for protected requests', async () => {
    const { gate } = fixture()
    const requests: { url: string; init?: RequestInit }[] = []
    const fetcher = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      requests.push({ url: String(url), init })
      return url === '/api/auth/session' ? session(helper) : new Response(null, { status: 204 })
    })
    for (const [method, path] of [
      ['GET', '/api/collections'],
      ['DELETE', '/api/collections/id/server-copy'],
      ['GET', '/api/exports/all.zip'],
      ['GET', '/api/exports/collections/id.zip'],
    ]) {
      await gate.request(fetcher, path!, { method })
    }
    const protectedRequests = requests.filter(({ url }) => url !== '/api/auth/session')
    expect(protectedRequests).toHaveLength(4)
    for (const { init } of protectedRequests) {
      expect(init).toMatchObject({ cache: 'no-store', credentials: 'same-origin' })
      const headers = new Headers(init?.headers)
      expect(headers.get('X-Capture-Account')).toBe(helper.id)
      expect(headers.get('X-Capture-Request')).toBe(init?.method === 'DELETE' ? '1' : null)
    }
  })

  it('downloads synced originals and thumbnails with the header and keeps Local Only photos on device', async () => {
    const { gate, repo } = fixture()
    const synced = await repo.createCollection({ name: 'Synced', storage_mode: 'synced' })
    const local = await repo.createCollection({ name: 'Private', storage_mode: 'local_only' })
    const addPhoto = async (collectionId: string) => {
      const entry = await repo.createEntry(collectionId)
      const [photo] = await repo.addPhotos(entry.id, [
        {
          blob: new NodeBlob(['original'], { type: 'image/jpeg' }),
          source: 'photo_library',
        },
      ])
      return photo!
    }
    const remote = await addPhoto(synced.id)
    const privatePhoto = await addPhoto(local.id)
    const fetcher = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      if (url === '/api/auth/session') return session(helper)
      expect(new Headers(init?.headers).get('X-Capture-Account')).toBe(helper.id)
      expect(init?.cache).toBe('no-store')
      return new Response('photo bytes')
    })
    // A helper must bind before synced data is created on its device.
    await repo.setSetting('account_id', helper.id)
    await repo.setSetting('account_name', helper.name)
    for (const kind of ['original', 'thumbnail']) {
      const response = await gate.request(fetcher, `/api/photos/${remote.id}/${kind}`, {}, remote.id)
      await expect(response.text()).resolves.toBe('photo bytes')
    }
    await expect(
      gate.request(fetcher, `/api/photos/${privatePhoto.id}/thumbnail`, {}, privatePhoto.id),
    ).rejects.toThrow('only available on this device')
    expect(
      fetcher.mock.calls.map(([url]) => url).filter((url) => String(url).includes('/api/photos/')),
    ).toEqual([`/api/photos/${remote.id}/original`, `/api/photos/${remote.id}/thumbnail`])
  })

  it('shows the account unavailable error without starting a protected transfer', async () => {
    const { gate } = fixture()
    const fetcher = vi.fn(async () => Response.json({ detail: 'account_unavailable' }, { status: 503 }))
    await expect(gate.request(fetcher, '/api/exports/all.zip')).rejects.toThrow('temporarily unavailable')
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(gate.current.kind).toBe('unavailable')
  })
})
