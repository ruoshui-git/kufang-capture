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
  it('moves a partial decimal count, keeps the source active, and undo restores both records', async () => {
    const { repo } = repoFor()
    const sourceCollection = await repo.createCollection({ name: 'A', storage_mode: 'local_only' })
    const targetCollection = await repo.createCollection({ name: 'B', storage_mode: 'local_only' })
    const source = await repo.createEntry(sourceCollection.id, {
      quantity: '10',
      unit: 'boxes',
      count_detail: 'old detail',
      entry_notes: 'Shelf 1',
    })
    const result = await repo.moveEntryPart(targetCollection.id, source.id, '2.5')
    expect(result.created[0]).toMatchObject({
      quantity: '2.5',
      unit: 'boxes',
      count_detail: '',
      entry_notes: '',
    })
    expect(await repo.getEntry(source.id)).toMatchObject({
      quantity: '7.5',
      count_detail: 'old detail',
      deleted_at: null,
      entry_notes: 'Shelf 1',
    })
    const [movement] = await first(repo.watchMovements(source.item_id))
    expect(movement).toMatchObject({
      kind: 'part',
      quantity: '2.5',
      unit: 'boxes',
      count_detail: '',
      undone_at: null,
      from_entry_id: source.id,
      to_entry_id: result.created[0]!.id,
      from_collection_id: sourceCollection.id,
      to_collection_id: targetCollection.id,
    })
    await repo.undoMove(result.undo)
    expect(await first(repo.watchMovements(source.item_id))).toEqual([
      expect.objectContaining({ id: movement!.id, undone_at: expect.any(String) }),
    ])
    expect(await repo.getEntry(source.id)).toMatchObject({ quantity: '10', entry_notes: 'Shelf 1' })
    expect(await repo.getEntry(result.created[0]!.id)).toMatchObject({ deleted_at: expect.any(String) })
  })

  it('rejects invalid partial amounts without changing source, target, or sequence', async () => {
    const { repo } = repoFor()
    const sourceCollection = await repo.createCollection({ name: 'A', storage_mode: 'local_only' })
    const targetCollection = await repo.createCollection({ name: 'B', storage_mode: 'local_only' })
    const blank = await repo.createEntry(sourceCollection.id)
    const source = await repo.createEntry(sourceCollection.id, { quantity: '10' })
    for (const [entry, amount] of [
      [blank, '1'],
      [source, '0'],
      [source, '-1'],
      [source, '10'],
      [source, '11'],
      [source, 'bad'],
    ] as const) {
      const before = await repo.getEntry(entry.id)
      const sequence = (await repo.getCollection(targetCollection.id))!.next_sequence_number
      await expect(repo.moveEntryPart(targetCollection.id, entry.id, amount)).rejects.toThrow()
      expect(await repo.getEntry(entry.id)).toEqual(before)
      expect((await repo.getCollection(targetCollection.id))!.next_sequence_number).toBe(sequence)
    }
  })

  it('adds a partial count to a matching active target and marks a different unit for review', async () => {
    const { repo } = repoFor()
    const sourceCollection = await repo.createCollection({ name: 'A', storage_mode: 'local_only' })
    const secondCollection = await repo.createCollection({ name: 'C', storage_mode: 'local_only' })
    const targetCollection = await repo.createCollection({ name: 'B', storage_mode: 'local_only' })
    const source = await repo.createEntry(sourceCollection.id, {
      title: 'Shared',
      quantity: '10',
      unit: 'boxes',
    })
    const second = (await repo.importEntries(secondCollection.id, [source.id])).created[0]!
    await repo.updateEntry(second.id, { quantity: '10', unit: 'pieces' })
    const target = (await repo.importEntries(targetCollection.id, [source.id])).created[0]!
    await repo.updateEntry(target.id, { quantity: '2', unit: 'Boxes' })
    const summed = await repo.moveEntryPart(targetCollection.id, source.id, '2.5')
    expect(summed.merged_into_existing[0]).toMatchObject({
      quantity: '4.5',
      entry_notes: '',
    })
    const mismatch = await repo.moveEntryPart(targetCollection.id, second.id, '1')
    expect(mismatch.merged_into_existing[0]).toMatchObject({
      quantity: '4.5',
      review_status: 'needs_review',
      entry_notes: '',
    })
  })

  it('restores a deleted target using only the moved count and refuses stale partial undo', async () => {
    const { repo } = repoFor()
    const sourceCollection = await repo.createCollection({ name: 'A', storage_mode: 'local_only' })
    const targetCollection = await repo.createCollection({ name: 'B', storage_mode: 'local_only' })
    const source = await repo.createEntry(sourceCollection.id, {
      title: 'Item',
      quantity: '12',
      unit: 'boxes',
      count_detail: 'whole source detail',
    })
    const target = (await repo.importEntries(targetCollection.id, [source.id])).created[0]!
    await repo.deleteEntry(target.id)
    const result = await repo.moveEntryPart(targetCollection.id, source.id, '5')
    expect(result.restored[0]).toMatchObject({
      id: target.id,
      quantity: '5',
      count_detail: '',
      entry_notes: '',
    })
    await repo.updateEntry(source.id, { entry_notes: 'Edited after partial move' })
    await expect(repo.undoMove(result.undo)).rejects.toThrow('changed since')
  })

  it('queues synced partial changes for both source and target', async () => {
    const { name, repo } = repoFor()
    const sourceCollection = await repo.createCollection({ name: 'A', storage_mode: 'synced' })
    const targetCollection = await repo.createCollection({ name: 'B', storage_mode: 'synced' })
    const source = await repo.createEntry(sourceCollection.id, { quantity: '12', unit: 'boxes' })
    const db = getCaptureDb(name)
    await db.outbox.clear()
    const result = await repo.moveEntryPart(targetCollection.id, source.id, '5')
    expect(await db.outbox.where('collection_id').equals(sourceCollection.id).count()).toBeGreaterThan(0)
    expect(await db.outbox.where('collection_id').equals(targetCollection.id).count()).toBeGreaterThan(0)
    expect(await repo.getEntry(source.id)).toMatchObject({
      quantity: '7',
      entry_notes: '',
    })
    expect(result.created[0]).toMatchObject({ quantity: '5', count_detail: '' })
    expect((await db.outbox.toArray()).find((row) => row.entity === 'movement')?.fields).toMatchObject({
      kind: 'part',
      quantity: '5',
      from_entry_id: source.id,
      to_entry_id: result.created[0]!.id,
    })
    await db.delete()
  })

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
      entry_notes: '',
    })
    expect((await repo.getEntry(source.id))?.deleted_at).not.toBeNull()
    expect((await repo.getEntry(source.id))?.entry_notes).toBe('Top shelf')
    expect((await repo.getEntry(source.id))?.sequence_number).toBe(1)
    expect((await repo.getCollection(targetCollection.id))?.next_sequence_number).toBe(2)
    expect((await first(repo.watchPhotos(result.created[0]!.id))).map((item) => item.id)).toContain(photo.id)
    const db = getCaptureDb(name)
    expect(await db.outbox.count()).toBe(0)
    expect(await db.movements.toArray()).toEqual([
      expect.objectContaining({
        kind: 'move',
        quantity: '5',
        count_detail: '3 boxes, 24 packs each',
        from_name: 'Batch B',
        to_name: 'Room A',
      }),
    ])
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
      entry_notes: 'Old note',
    })
    await repo.undoMove(result.undo)
    expect(await repo.getEntry(source.id)).toMatchObject({ deleted_at: null, entry_notes: '' })
    expect(await repo.getEntry(target.id)).toMatchObject({
      deleted_at: expect.any(String),
      quantity: '2',
      entry_notes: 'Old note',
    })
  })

  it('silently skips deleted source entries and entries already in the target collection', async () => {
    const { repo } = repoFor()
    const collection = await repo.createCollection({ name: 'Room', storage_mode: 'local_only' })
    const source = await repo.createEntry(collection.id)
    await repo.deleteEntry(source.id)
    const active = await repo.createEntry(collection.id)
    const result = await repo.moveEntries(collection.id, [source.id, active.id])
    expect(result.created).toEqual([])
    expect(result.restored).toEqual([])
    expect(result.merged_into_existing).toEqual([])
    expect((await repo.getEntry(active.id))?.deleted_at).toBeNull()
  })

  it('adds counts into an entry already there and notes the count from each location', async () => {
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
      unit: 'Boxes',
      count_detail: '3 boxes, 24 packs each',
    })
    const targetEntry = (await repo.importEntries(target.id, [source.id])).created[0]!
    await repo.updateEntry(targetEntry.id, { quantity: '2.5', unit: 'boxes' })
    const result = await repo.moveEntries(target.id, [duplicate.created[0]!.id])
    expect(result.merged_into_existing[0]).toMatchObject({
      quantity: '7.5',
      unit: 'boxes',
      entry_notes: '',
      review_status: 'draft',
    })
    expect(result.created).toHaveLength(0)
    expect(await first(repo.watchMovements(source.item_id))).toEqual([
      expect.objectContaining({
        target_before_quantity: '2.5',
        quantity: '5',
        unit: 'Boxes',
        from_name: 'B',
      }),
    ])
    await repo.undoMove(result.undo)
    expect(await repo.getEntry(duplicate.created[0]!.id)).toMatchObject({ deleted_at: null })
    expect(await repo.getEntry(targetEntry.id)).toMatchObject({
      quantity: '2.5',
      entry_notes: '',
      review_status: 'draft',
    })
  })

  it('moving the same item from two rooms sums the quantity and lists both sources', async () => {
    const { repo } = repoFor()
    const a = await repo.createCollection({ name: 'A', storage_mode: 'local_only' })
    const c = await repo.createCollection({ name: 'C', storage_mode: 'local_only' })
    const target = await repo.createCollection({ name: 'Target', storage_mode: 'local_only' })
    const fromA = await repo.createEntry(a.id, { title: 'Candles', quantity: '5' })
    const fromC = (await repo.importEntries(c.id, [fromA.id])).created[0]!
    await repo.updateEntry(fromC.id, { quantity: '3' })
    const first = await repo.moveEntries(target.id, [fromA.id])
    const second = await repo.moveEntries(target.id, [fromC.id])
    expect(second.merged_into_existing[0]).toMatchObject({
      id: first.created[0]!.id,
      quantity: '8',
      entry_notes: '',
      review_status: 'draft',
    })
  })

  it('never sums a blank quantity or different units, and marks the item for review', async () => {
    const { repo } = repoFor()
    const a = await repo.createCollection({ name: 'A', storage_mode: 'local_only' })
    const b = await repo.createCollection({ name: 'B', storage_mode: 'local_only' })
    const target = await repo.createCollection({ name: 'Target', storage_mode: 'local_only' })
    const source = await repo.createEntry(a.id, { quantity: '4', unit: 'packs' })
    const targetEntry = (await repo.importEntries(target.id, [source.id])).created[0]!
    await repo.updateEntry(targetEntry.id, { quantity: '2', unit: 'boxes' })
    const units = await repo.moveEntries(target.id, [source.id])
    expect(units.merged_into_existing[0]).toMatchObject({
      quantity: '2',
      entry_notes: '',
      review_status: 'needs_review',
    })
    const blank = (await repo.importEntries(b.id, [source.id])).created[0]!
    const other = await repo.createCollection({ name: 'Other', storage_mode: 'local_only' })
    const otherEntry = (await repo.importEntries(other.id, [source.id])).created[0]!
    await repo.updateEntry(otherEntry.id, { quantity: '6' })
    const blankMove = await repo.moveEntries(other.id, [blank.id])
    expect(blankMove.merged_into_existing[0]).toMatchObject({ quantity: '6' })
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
    expect(await first(repo.watchMovements(two.item_id))).toEqual([
      expect.objectContaining({ kind: 'split' }),
    ])
    await repo.undoMove(split.result.undo)
    expect((await first(repo.watchMovements(two.item_id)))[0]?.undone_at).toEqual(expect.any(String))
    await repo.splitEntries([two.id], { name: 'Split again' })
    const another = await repo.createCollection({ name: 'Another', storage_mode: 'local_only' })
    const third = await repo.createEntry(another.id, { title: 'Three' })
    const merged = await repo.mergeCollections(target.id, [source.id, another.id])
    expect(merged.created.map((entry) => entry.title)).toEqual(['One', 'Three'])
    expect((await repo.getCollection(source.id))?.status).toBe('archived')
    expect((await repo.getCollection(another.id))?.status).toBe('archived')
    expect((await repo.getEntry(one.id))?.sequence_number).toBe(1)
    expect((await repo.getEntry(third.id))?.sequence_number).toBe(1)
    expect(await first(repo.watchMovements(one.item_id))).toEqual([
      expect.objectContaining({ kind: 'merge' }),
    ])
    await repo.undoMove(merged.undo)
    expect((await first(repo.watchMovements(one.item_id)))[0]?.undone_at).toEqual(expect.any(String))
    expect((await repo.getCollection(source.id))?.status).toBe('active')
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
    const result = await repo.moveEntries(target.id, [entry.id])
    const created = result.created[0]!
    expect(await db.outbox.where('collection_id').equals(source.id).count()).toBeGreaterThan(0)
    expect(await db.outbox.where('collection_id').equals(target.id).count()).toBeGreaterThan(0)
    expect(created.quantity).toBe('4')
    await repo.undoMove(result.undo)
    expect(await db.outbox.where('collection_id').equals(source.id).count()).toBeGreaterThan(0)
    expect((await repo.getEntry(entry.id))?.deleted_at).toBeNull()
    await db.delete()
  })

  it('undoes a move, keeps the allocated number consumed, and rejects stale undo', async () => {
    const { repo } = repoFor()
    const sourceCollection = await repo.createCollection({ name: 'A', storage_mode: 'local_only' })
    const targetCollection = await repo.createCollection({ name: 'B', storage_mode: 'local_only' })
    const source = await repo.createEntry(sourceCollection.id, { entry_notes: 'Before' })
    const result = await repo.moveEntries(targetCollection.id, [source.id])
    await repo.undoMove(result.undo)
    expect(await repo.getEntry(source.id)).toMatchObject({
      deleted_at: null,
      sequence_number: 1,
      entry_notes: 'Before',
    })
    expect((await repo.getEntry(result.created[0]!.id))?.deleted_at).not.toBeNull()
    expect((await repo.createEntry(targetCollection.id)).sequence_number).toBe(2)
    const another = await repo.moveEntries(targetCollection.id, [source.id])
    await repo.updateEntry(source.id, { entry_notes: 'Changed after move' })
    await expect(repo.undoMove(another.undo)).rejects.toThrow(
      "This move can't be undone because the entry changed since.",
    )
  })
})
