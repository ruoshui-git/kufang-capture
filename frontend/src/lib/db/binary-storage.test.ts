// @vitest-environment node
// Browsers that cannot store Blobs in IndexedDB (Safari Private Browsing, WebKit ephemeral
// contexts) get photos stored as raw bytes. The bytes, hashes and exports must be identical.
import 'fake-indexeddb/auto'
import { describe, expect, it } from 'vitest'
import { createRepo } from './index'
import { readBlob, sha256 } from '../photos'

let n = 0
describe('photo storage without Blob support', () => {
  it('stores originals and thumbnails as bytes and returns identical Blobs', async () => {
    const repo = createRepo({
      databaseName: `bytes-mode-${++n}`,
      binaryStorage: 'bytes',
      imageProcessor: async () => ({
        width: 4,
        height: 3,
        thumbnail: new Blob(['thumb'], { type: 'image/jpeg' }),
      }),
    })
    const room = await repo.createCollection({ name: 'Private tab', storage_mode: 'local_only' })
    const entry = await repo.createEntry(room.id)
    const original = new Blob([new Uint8Array([0xff, 0xd8, 0xff, 1, 2, 3, 250])], { type: 'image/jpeg' })
    const [photo] = await repo.addPhotos(entry.id, [{ blob: original, source: 'native_camera' }])
    const stored = await repo.getPhotoBlob(photo!.id)
    expect(stored?.original).toBeInstanceOf(Blob)
    expect(stored?.original.type).toBe('image/jpeg')
    expect(new Uint8Array(await readBlob(stored!.original))).toEqual(new Uint8Array(await readBlob(original)))
    expect(await sha256(stored!.original)).toBe(photo!.sha256)
    expect(await stored?.thumbnail?.text()).toBe('thumb')
    const data = await repo.readForExport([room.id])
    expect(data.photos).toHaveLength(1)
  })
})
