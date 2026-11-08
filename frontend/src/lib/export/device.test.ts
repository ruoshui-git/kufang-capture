// @vitest-environment node
// One Blob implementation end to end (as in a browser); jsdom mixes realms.
import 'fake-indexeddb/auto'
import { describe, expect, it, vi } from 'vitest'
import { unzipSync } from 'fflate'
import { createRepo } from '../db'
import { readBlob } from '../photos'
import { exportFromDevice } from './device'

let n = 0
const repoFor = () =>
  createRepo({
    databaseName: `device-export-${++n}`,
    imageProcessor: async () => ({ width: 2, height: 1, thumbnail: new Blob(['t']) }),
  })

describe('device export', () => {
  it('exports one collection from IndexedDB with original bytes and records the export', async () => {
    const repo = repoFor()
    const room = await repo.createCollection({ name: 'Temple 2 / A04', storage_mode: 'local_only' })
    const other = await repo.createCollection({ name: 'Elsewhere', storage_mode: 'local_only' })
    const entry = await repo.createEntry(room.id, { quantity: '3', unit: 'boxes' })
    await repo.createEntry(other.id)
    const bytes = new Blob(['original-jpeg-bytes'], { type: 'image/jpeg' })
    const [photo] = await repo.addPhotos(entry.id, [{ blob: bytes, source: 'native_camera' }])
    let delivered: Blob | undefined
    const deliver = vi.fn(async (blob: Blob) => {
      delivered = blob
      return 'download' as const
    })

    const result = await exportFromDevice([room.id], {}, { repo, deliver })

    expect(result.manifest.counts).toMatchObject({ collections: 1, entries: 1, photos: 1 })
    expect(result.manifest.missing_originals).toEqual([])
    const files = unzipSync(new Uint8Array(await readBlob(delivered!)))
    const photoPath = Object.keys(files).find((p) => p.includes(`photos/${entry.id}/${photo!.id}`))
    expect(photoPath).toBeDefined()
    expect(new TextDecoder().decode(files[photoPath!])).toBe('original-jpeg-bytes')
    expect(Object.keys(files).some((p) => p.includes(other.id))).toBe(false)
    expect((await repo.getCollection(room.id))?.last_exported_at).toBe(result.manifest.exported_at)
    expect((await repo.getCollection(other.id))?.last_exported_at).toBeNull()
  })

  it('does not record an export the user cancelled', async () => {
    const repo = repoFor()
    const room = await repo.createCollection({ name: 'Room', storage_mode: 'local_only' })
    await exportFromDevice([room.id], {}, { repo, deliver: async () => 'cancelled' })
    expect((await repo.getCollection(room.id))?.last_exported_at).toBeNull()
  })
})
