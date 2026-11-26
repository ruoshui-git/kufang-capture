import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { Collection, Entry, Item, Photo } from '../types'
import { unzipSync } from 'fflate'
import { buildExport } from './build'
import { assignPaths, sanitize } from './paths'

interface Vectors {
  sanitize: Array<{ name: string; input: string; expected: string }>
  assignment: {
    collections: Array<{ id: string; name: string }>
    entries: Array<{
      id: string
      item: string
      collection: string
      sequence: number
      title: string
      active: boolean
    }>
    photos: Array<{ id: string; item: string; active: boolean; extension: string }>
    expected: {
      collection_dirs: Record<string, string>
      active: { photo_dirs: Record<string, string>; photo_paths: Record<string, string> }
      trash: { photo_dirs: Record<string, string>; photo_paths: Record<string, string> }
    }
  }
}

const vectors = JSON.parse(
  readFileSync(resolve(process.cwd(), '../tools/export-path-vectors.json'), 'utf8'),
) as Vectors

describe('export path vectors', () => {
  it.each(vectors.sanitize)('$name', ({ input, expected }) => {
    expect(sanitize(input)).toBe(expected)
  })

  it('assigns collection, entry and photo paths for active and trash sets', () => {
    const data = vectors.assignment
    const collections = data.collections as Collection[]
    const items = [...new Map(data.entries.map((entry) => [entry.item, entry.title])).entries()].map(
      ([id, title]) => ({ id, title }) as Item,
    )
    const entries = data.entries.map(
      (entry) =>
        ({
          id: entry.id,
          item_id: entry.item,
          collection_id: entry.collection,
          sequence_number: entry.sequence,
          deleted_at: entry.active ? null : 'deleted',
        }) as Entry,
    )
    const photos = data.photos.map(
      (photo) =>
        ({
          id: photo.id,
          item_id: photo.item,
          deleted_at: photo.active ? null : 'deleted',
          sort_order: 0,
          captured_at: '2026-01-01T00:00:00Z',
        }) as Photo,
    )
    const activeItems = new Set(
      entries.filter((entry) => entry.deleted_at === null).map((entry) => entry.item_id),
    )
    const allExtensions = new Map(data.photos.map((photo) => [photo.id, photo.extension]))
    const active = assignPaths(
      collections,
      items,
      photos.filter((photo) => photo.deleted_at === null && activeItems.has(photo.item_id)),
      entries.filter((entry) => entry.deleted_at === null),
      activeItems,
      false,
      allExtensions,
    )
    const trash = assignPaths(
      collections,
      items,
      photos.filter((photo) => photo.deleted_at !== null || !activeItems.has(photo.item_id)),
      entries
        .filter((entry) => entry.deleted_at === null)
        .concat(entries.filter((entry) => entry.deleted_at !== null)),
      activeItems,
      true,
      allExtensions,
    )
    expect(Object.fromEntries(active.collectionDirs)).toEqual(data.expected.collection_dirs)
    expect(Object.fromEntries(active.photoDirs)).toMatchObject(data.expected.active.photo_dirs)
    expect(Object.fromEntries(active.photoPaths)).toEqual(data.expected.active.photo_paths)
    expect(Object.fromEntries(trash.photoDirs)).toMatchObject(data.expected.trash.photo_dirs)
    expect(Object.fromEntries(trash.photoPaths)).toEqual(data.expected.trash.photo_paths)
  })

  it('builds the shared vector paths into a device archive', async () => {
    const data = vectors.assignment
    const at = '2026-11-08T07:00:00.000Z'
    const collections = data.collections.map(
      (row) =>
        ({
          id: row.id,
          name: row.name,
          folder: '',
          description: '',
          status: 'active',
          storage_mode: 'synced',
          next_sequence_number: 100,
          created_at: at,
          updated_at: at,
          archived_at: null,
        }) as Collection,
    )
    const items = [...new Map(data.entries.map((row) => [row.item, row.title])).entries()].map(
      ([id, title]) =>
        ({ id, title, notes: '', dimensions: '', review_status: 'draft', updated_at: at }) as Item,
    )
    const entries = data.entries.map(
      (row) =>
        ({
          id: row.id,
          item_id: row.item,
          collection_id: row.collection,
          sequence_number: row.sequence,
          quantity: null,
          unit: '',
          count_detail: '',
          entry_notes: '',
          starred_at: null,
          deleted_at: row.active ? null : at,
          created_at: at,
          updated_at: at,
        }) as Entry,
    )
    const originals = new Map<string, Blob>()
    const photos = await Promise.all(
      data.photos.map(async (row, index) => {
        const bytes = new Uint8Array([index + 1])
        const sha256 = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as BufferSource))]
          .map((byte) => byte.toString(16).padStart(2, '0'))
          .join('')
        originals.set(row.id, new Blob([bytes]))
        return {
          id: row.id,
          item_id: row.item,
          sort_order: index,
          original_filename: `${row.id}.jpg`,
          mime_type: 'image/jpeg',
          byte_size: bytes.length,
          width: 1,
          height: 1,
          sha256,
          crc32: crc32(bytes),
          captured_at: at,
          capture_source: 'native_camera',
          caption: '',
          is_cover: index === 0,
          deleted_at: row.active ? null : at,
          created_at: at,
          updated_at: at,
        } as Photo
      }),
    )
    const result = await buildExport(
      { collections, entries, items, photos, movements: [], getOriginal: async (id) => originals.get(id)! },
      { scope: 'all', includeTrash: true, exportedAt: at, appVersion: 'test', source: 'device' },
    )
    if (process.env.W2_EXPORT_SAMPLE === '1') {
      const output = '/tmp/codex-runs/w2-export-v3-shots'
      mkdirSync(output, { recursive: true })
      writeFileSync(`${output}/device-v3.zip`, new Uint8Array(await result.blob.arrayBuffer()))
    }
    const files = unzipSync(new Uint8Array(await result.blob.arrayBuffer()))
    const activePhotos = JSON.parse(new TextDecoder().decode(files['capture-export/photos.json']))
    const trashPhotos = JSON.parse(new TextDecoder().decode(files['capture-export/trash/photos.json']))
    const activeEntries = JSON.parse(new TextDecoder().decode(files['capture-export/entries.json']))
    const trashEntries = JSON.parse(new TextDecoder().decode(files['capture-export/trash/entries.json']))
    expect(
      Object.fromEntries(
        activePhotos.map((row: { photo_id: string; path: string }) => [row.photo_id, row.path]),
      ),
    ).toEqual(data.expected.active.photo_paths)
    expect(
      Object.fromEntries(
        trashPhotos.map((row: { photo_id: string; path: string }) => [row.photo_id, row.path]),
      ),
    ).toEqual(data.expected.trash.photo_paths)
    expect(
      Object.fromEntries(
        activeEntries.map((row: { entry_id: string; photo_dir: string }) => [row.entry_id, row.photo_dir]),
      ),
    ).toMatchObject(data.expected.active.photo_dirs)
    expect(
      Object.fromEntries(
        trashEntries.map((row: { entry_id: string; photo_dir: string }) => [row.entry_id, row.photo_dir]),
      ),
    ).toMatchObject(data.expected.trash.photo_dirs)
  })
})

function crc32(bytes: Uint8Array): number {
  let value = 0xffffffff
  for (const byte of bytes) {
    value ^= byte
    for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
  }
  return (value ^ 0xffffffff) >>> 0
}
