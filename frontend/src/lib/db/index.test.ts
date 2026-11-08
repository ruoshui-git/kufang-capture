import { describe, expect, it } from 'vitest'
import Dexie from 'dexie'
import { Blob as NodeBlob } from 'node:buffer'
import { createRepo } from './index'
import { crc32, readBlob } from '../photos'
import { addDecimals, isIncomplete, normalizeUnit } from '../summary'

let counter = 0
function isolatedRepo(
  imageProcessor?: (blob: Blob) => Promise<{ width: number; height: number; thumbnail: Blob }>,
) {
  return createRepo({ databaseName: `capture-test-${++counter}`, imageProcessor })
}

async function first<T>(watch: {
  subscribe(
    next: (value: T) => void,
    error?: (error: unknown) => void,
  ): (() => void) | { unsubscribe(): void }
}): Promise<T> {
  return new Promise((resolve, reject) => {
    const off = watch.subscribe((value) => {
      if (typeof off === 'function') off()
      else off?.unsubscribe()
      resolve(value)
    }, reject)
    setTimeout(() => reject(new Error('watch timed out')), 2000)
  })
}

describe('Dexie repository', () => {
  it('gives rapid concurrent captures distinct sort orders and exactly one cover', async () => {
    const repo = isolatedRepo(async () => ({ width: 1, height: 1, thumbnail: new NodeBlob(['t']) as Blob }))
    const collection = await repo.createCollection({ name: 'Burst', storage_mode: 'local_only' })
    const entry = await repo.createEntry(collection.id)
    await Promise.all(
      Array.from({ length: 6 }, (_, i) =>
        repo.addPhotos(entry.id, [
          { blob: new NodeBlob([`frame ${i}`], { type: 'image/jpeg' }) as Blob, source: 'camera_frame' },
        ]),
      ),
    )
    const photos = await first(repo.watchPhotos(entry.id))
    expect(photos).toHaveLength(6)
    expect(new Set(photos.map((p) => p.sort_order)).size).toBe(6)
    expect(photos.filter((p) => p.is_cover)).toHaveLength(1)
  })

  it('allocates unique monotonically increasing numbers under concurrent writes and never reuses deletes', async () => {
    const repo = isolatedRepo()
    const collection = await repo.createCollection({ name: 'Room', storage_mode: 'local_only' })
    const entries = await Promise.all(Array.from({ length: 20 }, () => repo.createEntry(collection.id)))
    expect(entries.map((entry) => entry.sequence_number).sort((a, b) => a - b)).toEqual(
      Array.from({ length: 20 }, (_, i) => i + 1),
    )
    await repo.deleteEntry(entries[4]!.id)
    await repo.restoreEntry(entries[4]!.id)
    expect((await repo.createEntry(collection.id)).sequence_number).toBe(21)
  })

  it('keeps Local Only entries out of pending sync and applies incomplete rules', async () => {
    const repo = isolatedRepo()
    const collection = await repo.createCollection({ name: 'Local', storage_mode: 'local_only' })
    const entry = await repo.createEntry(collection.id, { quantity: '0' })
    await repo.updateEntry(entry.id, { notes: 'shelf' })
    const rows = await first(
      repo.watchEntryRows(collection.id, { search: '', filter: 'all', sort: 'newest' }),
    )
    expect(rows[0]?.pending_sync).toBe(false)
    expect(rows[0]?.is_incomplete).toBe(true)
    expect((await repo.getEntry(entry.id))?.sync_state).toBe('local_only')
  })

  it('preserves originals when thumbnail processing fails and records checksums', async () => {
    const repo = isolatedRepo(async () => {
      throw new Error('decode failed')
    })
    const collection = await repo.createCollection({ name: 'Photos', storage_mode: 'local_only' })
    const entry = await repo.createEntry(collection.id)
    const input = new NodeBlob(['raw image bytes'], { type: 'image/jpeg' })
    const [photo] = await repo.addPhotos(entry.id, [{ blob: input, source: 'photo_library' }])
    const stored = await repo.getPhotoBlob(photo!.id)
    expect([...new Uint8Array(await readBlob(stored!.original))]).toEqual([
      ...new Uint8Array(await readBlob(input)),
    ])
    expect(stored?.thumbnail).toBeNull()
    expect(photo?.original_filename).toMatch(/^IMG_.*\.jpg$/)
  })

  it('calculates standard CRC-32 and exact unit arithmetic', async () => {
    expect(await crc32(new Blob(['123456789']))).toBe(0xcbf43926)
    expect(addDecimals('0.1', '0.2')).toBe('0.3')
    expect(addDecimals('5', '12')).toBe('17')
    expect(normalizeUnit('Boxes ')).toBe(normalizeUnit('boxes'))
    expect(isIncomplete({ quantity: null, review_status: 'draft' }, true)).toBe(true)
    expect(isIncomplete({ quantity: '0', review_status: 'draft' }, true)).toBe(false)
  })

  it('coalesces synced edits into one not-in-flight outbox item', async () => {
    const name = `capture-test-outbox-${++counter}`
    const repo = createRepo({ databaseName: name })
    const collection = await repo.createCollection({ name: 'Synced', storage_mode: 'synced' })
    const entry = await repo.createEntry(collection.id)
    await repo.updateEntry(entry.id, { title: 'First' })
    await repo.updateEntry(entry.id, { notes: 'Second' })
    const db = new Dexie(name)
    db.version(1).stores({
      collections: 'id',
      entries: 'id',
      photos: 'id',
      photoBlobs: 'photo_id',
      outbox:
        'id, [collection_id+entity_id], [collection_id+entity+entity_id], next_attempt_at, collection_id',
      settings: 'key',
    })
    const items = await db
      .table('outbox')
      .where('[collection_id+entity+entity_id]')
      .equals([collection.id, 'entry', entry.id])
      .toArray()
    expect(items).toHaveLength(1)
    expect(items[0].fields).toMatchObject({ title: 'First', notes: 'Second' })
    db.close()
  })
})

describe('repository recovery and summaries', () => {
  it('restores entry photos, preserves sequence, and maintains one active cover', async () => {
    const repo = isolatedRepo(async () => ({ width: 10, height: 10, thumbnail: new NodeBlob(['preview']) }))
    const collection = await repo.createCollection({ name: 'Room', storage_mode: 'local_only' })
    const entry = await repo.createEntry(collection.id)
    const photos = await repo.addPhotos(entry.id, [
      { blob: new NodeBlob(['one']), source: 'photo_library', captured_at: '2026-01-01T00:00:00.000Z' },
      { blob: new NodeBlob(['two']), source: 'photo_library', captured_at: '2026-01-03T00:00:00.000Z' },
    ])
    await repo.setCoverPhoto(photos[1]!.id)
    await repo.deletePhoto(photos[1]!.id)
    const live = await first(
      repo.watchEntryRows(collection.id, { search: '', filter: 'all', sort: 'newest' }),
    )
    expect(live[0]?.recent_photos.map((photo) => photo.id)).toEqual([photos[0]!.id])
    await repo.deleteEntry(entry.id)
    await repo.restoreEntry(entry.id)
    expect((await repo.getEntry(entry.id))?.sequence_number).toBe(1)
    const rows = await first(repo.watchPhotos(entry.id, { includeDeleted: true }))
    expect(rows).toHaveLength(2)
    expect(rows.find((photo) => photo.deleted_at === null)?.is_cover).toBe(true)
  })

  it('groups exact quantity sums by normalized unit and selects the latest spelling', async () => {
    const repo = isolatedRepo()
    const collection = await repo.createCollection({ name: 'Counts', storage_mode: 'local_only' })
    await repo.createEntry(collection.id, { quantity: '0.1', unit: 'Boxes' })
    await repo.createEntry(collection.id, { quantity: '0.2', unit: 'boxes ' })
    await repo.createEntry(collection.id, { quantity: '5', unit: 'boxes' })
    await repo.createEntry(collection.id, { quantity: '12', unit: 'pieces' })
    await repo.createEntry(collection.id, { quantity: null, unit: 'Boxes' })
    const summary = await first(repo.watchCollectionSummary(collection.id))
    expect(summary?.quantity_by_unit).toContainEqual({ unit: 'boxes', total: '5.3', entry_count: 3 })
    expect(summary?.quantity_by_unit).toContainEqual({ unit: 'pieces', total: '12', entry_count: 1 })
  })

  it('blocks clearing until a fresh export, rejects a wrong name, then clears all local rows', async () => {
    const repo = isolatedRepo()
    const collection = await repo.createCollection({ name: 'Archive A', storage_mode: 'local_only' })
    await repo.createEntry(collection.id)
    expect((await repo.checkClearCollection(collection.id)).allowed).toBe(false)
    await repo.markExported([collection.id], new Date(Date.now() + 1000).toISOString())
    await expect(repo.clearCollection(collection.id, 'archive a')).rejects.toThrow('did not match')
    await repo.clearCollection(collection.id, 'Archive A')
    expect(await repo.getCollection(collection.id)).toBeUndefined()
  })
})

describe('query and sync invariants', () => {
  it('keeps an in-flight mutation separate and coalesces later fields in a new item', async () => {
    const name = `capture-test-flight-${++counter}`
    const repo = createRepo({ databaseName: name })
    const collection = await repo.createCollection({ name: 'Synced', storage_mode: 'synced' })
    const entry = await repo.createEntry(collection.id)
    const db = new Dexie(name)
    db.version(1).stores({
      collections: 'id',
      entries: 'id',
      photos: 'id',
      photoBlobs: 'photo_id',
      outbox:
        'id, [collection_id+entity_id], [collection_id+entity+entity_id], next_attempt_at, collection_id',
      settings: 'key',
    })
    const original = await db
      .table('outbox')
      .where('[collection_id+entity+entity_id]')
      .equals([collection.id, 'entry', entry.id])
      .first()
    await db.table('outbox').put({ ...original, in_flight: true })
    await repo.updateEntry(entry.id, { title: 'after send started' })
    const items = await db
      .table('outbox')
      .where('[collection_id+entity+entity_id]')
      .equals([collection.id, 'entry', entry.id])
      .toArray()
    expect(items).toHaveLength(2)
    expect(items.find((item) => item.in_flight)?.fields.title).toBe('')
    expect(items.find((item) => !item.in_flight)?.fields.title).toBe('after send started')
    db.close()
  })

  it('searches sequence labels, plain numbers, titles and notes', async () => {
    const repo = isolatedRepo()
    const collection = await repo.createCollection({ name: 'Search', storage_mode: 'local_only' })
    const firstEntry = await repo.createEntry(collection.id, { title: 'Candles' })
    const secondEntry = await repo.createEntry(collection.id, { notes: 'fragile glass' })
    const thirdEntry = await repo.createEntry(collection.id)
    for (const [term, expected] of [
      ['#0003', thirdEntry.id],
      ['3', thirdEntry.id],
      ['Candles', firstEntry.id],
      ['fragile', secondEntry.id],
    ]) {
      const rows = await first(
        repo.watchEntryRows(collection.id, { search: term!, filter: 'all', sort: 'newest' }),
      )
      expect(rows.map((row) => row.entry.id)).toContain(expected)
    }
  })

  it('orders recent photos by capture time independently of manual sort order', async () => {
    const repo = isolatedRepo(async () => ({ width: 8, height: 8, thumbnail: new NodeBlob(['thumb']) }))
    const collection = await repo.createCollection({ name: 'Camera', storage_mode: 'local_only' })
    const entry = await repo.createEntry(collection.id)
    const photos = await repo.addPhotos(entry.id, [
      { blob: new NodeBlob(['old']), source: 'photo_library', captured_at: '2026-01-01T00:00:00.000Z' },
      { blob: new NodeBlob(['new']), source: 'photo_library', captured_at: '2026-01-03T00:00:00.000Z' },
    ])
    await repo.reorderPhotos(entry.id, [photos[1]!.id, photos[0]!.id])
    const rows = await first(
      repo.watchEntryRows(collection.id, { search: '', filter: 'all', sort: 'newest' }),
    )
    expect(rows[0]?.recent_photos.map((photo) => photo.id)).toEqual([photos[1]!.id, photos[0]!.id])
  })

  it('blocks clear after any edit made after the export', async () => {
    let date = new Date('2026-11-08T07:00:00.000Z')
    const repo = createRepo({ databaseName: `capture-test-clear-${++counter}`, now: () => date })
    const collection = await repo.createCollection({ name: 'Room', storage_mode: 'local_only' })
    const entry = await repo.createEntry(collection.id)
    await repo.markExported([collection.id], date.toISOString())
    date = new Date(date.getTime() + 1000)
    await repo.updateEntry(entry.id, { notes: 'changed after export' })
    const check = await repo.checkClearCollection(collection.id)
    expect(check.allowed).toBe(false)
    expect(check.unexported_changes).toBe(true)
  })
})
