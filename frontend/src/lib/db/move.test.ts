import { describe, expect, it } from 'vitest'
import { createRepo, getCaptureDb } from './index'

let counter = 0
const repoFor = () => {
  const name = `capture-move-${++counter}`
  return {
    name,
    repo: createRepo({
      databaseName: name,
      imageProcessor: async () => ({ width: 1, height: 1, thumbnail: new Blob(['thumb']) }),
    }),
  }
}
const first = <T>(watch: { subscribe(next: (value: T) => void): (() => void) | { unsubscribe(): void } }) =>
  new Promise<T>((resolve) => {
    const off = watch.subscribe((value) => {
      if (typeof off === 'function') off()
      else off?.unsubscribe()
      resolve(value)
    })
  })

describe('moving entries', () => {
  it('moves new entries with counts, provenance, shared photos, and immutable source numbering', async () => {
    const { name, repo } = repoFor()
    const sourceCollection = await repo.createCollection({ name: 'Batch B', storage_mode: 'local_only' })
    const targetCollection = await repo.createCollection({ name: 'Room A', storage_mode: 'local_only' })
    const source = await repo.createEntry(sourceCollection.id, {
      title: 'Crate',
      quantity: '5',
      unit: 'boxes',
      count_detail: '3 boxes, 24 packs each',
      entry_notes: 'Top shelf',
    })
    const photo = (
      await repo.addPhotos(source.id, [{ blob: new Blob(['photo']), source: 'photo_library' }])
    )[0]!
    const result = await repo.moveEntries(targetCollection.id, [source.id])
    expect(result.created).toHaveLength(1)
    expect(result.created[0]).toMatchObject({
      sequence_number: 1,
      quantity: '5',
      unit: 'boxes',
      count_detail: '3 boxes, 24 packs each',
      entry_notes: 'Moved from "Batch B" #0001\nTop shelf',
    })
    expect((await repo.getEntry(source.id))?.deleted_at).not.toBeNull()
    expect((await repo.getEntry(source.id))?.sequence_number).toBe(1)
    expect((await repo.getCollection(targetCollection.id))?.next_sequence_number).toBe(2)
    expect((await first(repo.watchPhotos(result.created[0]!.id))).map((item) => item.id)).toContain(photo.id)
    const db = getCaptureDb(name)
    expect(await db.outbox.count()).toBe(0)
    await db.delete()
  })

  it('restores a deleted target entry with source counts and old number', async () => {
    const { repo } = repoFor()
    const sourceCollection = await repo.createCollection({ name: 'Source', storage_mode: 'local_only' })
    const targetCollection = await repo.createCollection({ name: 'Target', storage_mode: 'local_only' })
    const source = await repo.createEntry(sourceCollection.id, {
      title: 'Shared',
      quantity: '9',
      unit: 'pieces',
    })
    const target = (await repo.importEntries(targetCollection.id, [source.id])).created[0]!
    await repo.updateEntry(target.id, { quantity: '2', entry_notes: 'Old note' })
    await repo.deleteEntry(target.id)
    const result = await repo.moveEntries(targetCollection.id, [source.id])
    expect(result.restored[0]).toMatchObject({
      id: target.id,
      sequence_number: target.sequence_number,
      quantity: '9',
      entry_notes: 'Moved from "Source" #0001',
    })
  })

  it('silently skips deleted source entries and entries already in the target collection', async () => {
    const { repo } = repoFor()
    const collection = await repo.createCollection({ name: 'Room', storage_mode: 'local_only' })
    const source = await repo.createEntry(collection.id)
    await repo.deleteEntry(source.id)
    const active = await repo.createEntry(collection.id)
    const result = await repo.moveEntries(collection.id, [source.id, active.id])
    expect(result).toEqual({ created: [], restored: [], merged_into_existing: [] })
    expect((await repo.getEntry(active.id))?.deleted_at).toBeNull()
  })

  it('notes active duplicates and marks shared item needs review when counts differ', async () => {
    const { repo } = repoFor()
    const a = await repo.createCollection({ name: 'A', storage_mode: 'local_only' })
    const b = await repo.createCollection({ name: 'B', storage_mode: 'local_only' })
    const target = await repo.createCollection({ name: 'Target', storage_mode: 'local_only' })
    const source = await repo.createEntry(a.id, {
      title: 'Same item',
      quantity: '5',
      unit: 'boxes',
      count_detail: '3 boxes, 24 packs each',
    })
    const duplicate = await repo.importEntries(b.id, [source.id])
    await repo.updateEntry(duplicate.created[0]!.id, {
      quantity: '5',
      unit: 'boxes',
      count_detail: '3 boxes, 24 packs each',
    })
    const targetEntry = (await repo.importEntries(target.id, [source.id])).created[0]!
    await repo.updateEntry(targetEntry.id, { quantity: '2', unit: 'boxes' })
    const result = await repo.moveEntries(target.id, [duplicate.created[0]!.id])
    expect(result.merged_into_existing[0]?.entry_notes).toContain(
      'Moved from "B" #0001: 5 boxes; 3 boxes, 24 packs each',
    )
    expect(result.merged_into_existing[0]?.review_status).toBe('needs_review')
    expect(result.created).toHaveLength(0)
  })

  it('rejects storage mismatch and split and merge operate atomically in the requested order', async () => {
    const { repo } = repoFor()
    const source = await repo.createCollection({
      name: 'Source',
      folder: 'North',
      storage_mode: 'local_only',
    })
    const target = await repo.createCollection({ name: 'Target', storage_mode: 'local_only' })
    const one = await repo.createEntry(source.id, { title: 'One' })
    const two = await repo.createEntry(source.id, { title: 'Two' })
    const split = await repo.splitEntries([two.id], { name: 'Split', folder: 'North' })
    expect(split.collection.storage_mode).toBe('local_only')
    expect(split.result.created[0]?.title).toBe('Two')
    const another = await repo.createCollection({ name: 'Another', storage_mode: 'local_only' })
    const third = await repo.createEntry(another.id, { title: 'Three' })
    const merged = await repo.mergeCollections(target.id, [source.id, another.id])
    expect(merged.created.map((entry) => entry.title)).toEqual(['One', 'Three'])
    expect((await repo.getCollection(source.id))?.status).toBe('archived')
    expect((await repo.getCollection(another.id))?.status).toBe('archived')
    expect((await repo.getEntry(one.id))?.sequence_number).toBe(1)
    expect((await repo.getEntry(third.id))?.sequence_number).toBe(1)
    const synced = await repo.createCollection({ name: 'Synced', storage_mode: 'synced' })
    const mismatchSource = await repo.createEntry(source.id)
    await expect(repo.moveEntries(synced.id, [mismatchSource.id])).rejects.toThrow('same storage mode')
  })

  it('queues entity changes for synced moves and none for local-only moves', async () => {
    const { name, repo } = repoFor()
    const source = await repo.createCollection({ name: 'Synced source', storage_mode: 'synced' })
    const target = await repo.createCollection({ name: 'Synced target', storage_mode: 'synced' })
    const entry = await repo.createEntry(source.id, { quantity: '4', unit: 'packs' })
    const db = getCaptureDb(name)
    await db.outbox.clear()
    const created = (await repo.moveEntries(target.id, [entry.id])).created[0]!
    expect(await db.outbox.where('collection_id').equals(source.id).count()).toBeGreaterThan(0)
    expect(await db.outbox.where('collection_id').equals(target.id).count()).toBeGreaterThan(0)
    expect(created.quantity).toBe('4')
    await db.delete()
  })
})
