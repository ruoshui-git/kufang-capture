import { afterEach, describe, expect, it, vi } from 'vitest'
import { createShare, fetchShared, fetchSharedPhoto, listShares, revokeShare } from './api'
import type { SharedCollection } from './contract'

const token = 'a'.repeat(43)
const snapshot: SharedCollection = {
  schema: 1,
  share: { label: null, expires_at: null },
  collection: {
    id: 'collection',
    name: 'Room',
    description: '',
    folder: '',
    status: 'active',
    archived_at: null,
  },
  entries: [],
  updated_at: '2026-11-26T15:00:00.000Z',
}

afterEach(() => vi.unstubAllGlobals())

describe('public share API', () => {
  it('sends the token only in the header and omits credentials', async () => {
    const mock = vi
      .fn()
      .mockResolvedValueOnce(Response.json(snapshot))
      .mockResolvedValueOnce(new Response('jpeg'))
    vi.stubGlobal('fetch', mock)
    expect(await fetchShared(token)).toEqual(snapshot)
    const photo = await fetchSharedPhoto(token, 'photo-id', 'original')
    expect(await photo.text()).toBe('jpeg')
    for (const [url, init] of mock.mock.calls) {
      expect(url).not.toContain(token)
      expect(init).toMatchObject({
        headers: { 'X-Capture-Share': token },
        credentials: 'omit',
        cache: 'no-store',
        redirect: 'error',
        referrerPolicy: 'no-referrer',
      })
    }
    expect(mock.mock.calls.map(([path]) => path)).toEqual([
      '/api/share',
      '/api/share/photos/photo-id/original',
    ])
  })

  it('does not fetch an invalid token, including for photos', async () => {
    const mock = vi.fn()
    vi.stubGlobal('fetch', mock)
    await expect(fetchShared('malformed')).rejects.toMatchObject({ code: 'share_required' })
    await expect(fetchSharedPhoto('malformed', 'photo', 'thumbnail')).rejects.toMatchObject({
      code: 'share_required',
    })
    expect(mock).not.toHaveBeenCalled()
  })

  it.each([
    [401, 'share_required'],
    [404, 'share_not_found'],
    [410, 'share_expired'],
    [429, 'too_many_attempts'],
  ])('keeps %s share errors typed', async (status, detail) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ detail }, { status })))
    await expect(fetchShared(token)).rejects.toMatchObject({ code: detail })
  })

  it('reports a connection error, while preserving cancellation', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('offline')))
    await expect(fetchShared(token)).rejects.toMatchObject({ code: 'network' })
    const controller = new AbortController()
    controller.abort()
    await expect(fetchShared(token, controller.signal)).rejects.toMatchObject({ name: 'AbortError' })
  })
})

describe('owner share API', () => {
  const session = { authenticated: true, user: { id: 'owner', name: 'Owner', is_owner: true } }

  it('lists, creates and revokes under the verified account and mutation headers', async () => {
    const { repo } = await import('$lib/db')
    const collection = await repo.createCollection({ name: 'Shared room', storage_mode: 'synced' })
    const link = {
      id: 'link/id',
      collection_id: collection.id,
      url: `https://example.test/share#${token}`,
      label: 'Boss',
    }
    const mock = vi.fn(async (path: string, init: RequestInit) => {
      if (path === '/api/auth/session') return Response.json(session)
      const headers = new Headers(init.headers)
      expect(headers.get('X-Capture-Account')).toBe('owner')
      expect(init.credentials).toBe('same-origin')
      expect(init.cache).toBe('no-store')
      if (init.method === 'POST') {
        expect(headers.get('X-Capture-Request')).toBe('1')
        expect(JSON.parse(init.body as string)).toEqual({
          collection_id: collection.id,
          label: 'Boss',
          expires_in_days: 30,
        })
        return Response.json(link, { status: 201 })
      }
      if (init.method === 'DELETE') {
        expect(headers.get('X-Capture-Request')).toBe('1')
        expect(path).toBe('/api/shares/link%2Fid')
        return new Response(null, { status: 204 })
      }
      expect(path).toBe(`/api/shares?collection_id=${collection.id}`)
      return Response.json({ shares: [link] })
    })
    vi.stubGlobal('fetch', mock)
    await expect(listShares(collection.id)).resolves.toEqual([link])
    await expect(
      createShare({ collection_id: collection.id, label: 'Boss', expires_in_days: 30 }),
    ).resolves.toEqual(link)
    await expect(revokeShare(link.id, undefined, collection.id)).resolves.toBeUndefined()
    expect(mock).toHaveBeenCalledTimes(6)
  })

  it('never fetches for a Local Only collection', async () => {
    const { repo } = await import('$lib/db')
    const collection = await repo.createCollection({ name: 'Local room', storage_mode: 'local_only' })
    const mock = vi.fn()
    vi.stubGlobal('fetch', mock)
    await expect(listShares(collection.id)).rejects.toMatchObject({ code: 'local_only' })
    await expect(createShare({ collection_id: collection.id })).rejects.toMatchObject({ code: 'local_only' })
    await expect(revokeShare('some-id', undefined, collection.id)).rejects.toMatchObject({
      code: 'local_only',
    })
    expect(mock).not.toHaveBeenCalled()
  })

  it('checks storage again after an in-flight sign-in check', async () => {
    const { repo } = await import('$lib/db')
    const collection = await repo.createCollection({ name: 'Changing room', storage_mode: 'synced' })
    const mock = vi.fn(async (_path: string) => {
      await repo.setStorageMode(collection.id, 'local_only', { consentToUploadExisting: false })
      return Response.json(session)
    })
    vi.stubGlobal('fetch', mock)
    await expect(createShare({ collection_id: collection.id })).rejects.toMatchObject({ code: 'local_only' })
    expect(mock.mock.calls.map(([path]) => path)).toEqual(['/api/auth/session'])
  })
})
