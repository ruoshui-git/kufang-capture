import { Blob as NodeBlobImpl } from 'node:buffer'
import { describe, expect, it } from 'vitest'
import { createRepo, getCaptureDb } from './index'

const NodeBlob = NodeBlobImpl as unknown as typeof Blob
let counter = 0

function first<T>(watch: {
  subscribe(
    next: (value: T) => void,
    error?: (cause: unknown) => void,
  ): (() => void) | { unsubscribe(): void }
}): Promise<T> {
  return new Promise((resolve, reject) => {
    const subscription = watch.subscribe((value) => {
      if (typeof subscription === 'function') subscription()
      else subscription.unsubscribe()
      resolve(value)
    }, reject)
  })
}

describe('collection summaries', () => {
  it('preserves summary values for folders, archived and deleted records, uploads and unit totals', async () => {
    const name = `capture-summaries-${++counter}`
    const fixed = '2026-11-20T12:00:00.000Z'
    const repo = createRepo({
      databaseName: name,
      now: () => new Date(fixed),
      imageProcessor: async () => ({ width: 1, height: 1, thumbnail: new NodeBlob(['thumb']) }),
    })
    const collection = await repo.createCollection({
      name: 'North shelf',
      folder: 'Temple 2',
      storage_mode: 'synced',
    })
    const active = await repo.createEntry(collection.id, { quantity: '5', unit: 'Boxes' })
    const deleted = await repo.createEntry(collection.id, { quantity: '12', unit: 'pieces' })
    await repo.deleteEntry(deleted.id)
    const [activePhoto, deletedPhoto] = await repo.addPhotos(active.id, [
      { blob: new NodeBlob(['active']), source: 'photo_library' },
      { blob: new NodeBlob(['deleted photo']), source: 'photo_library' },
    ])
    await repo.deletePhoto(deletedPhoto!.id)
    const archived = await repo.createCollection({
      name: 'Archive',
      folder: 'Back room',
      storage_mode: 'synced',
    })
    await repo.archiveCollection(archived.id)

    const db = getCaptureDb(name)
    // Attach an active upload to the deleted entry so it remains pending, as before.
    const extra = await repo.addPhotos(deleted.id, [
      { blob: new NodeBlob(['deleted entry photo']), source: 'photo_library' },
    ])
    // Ensure the three upload-state cases and all activity dates are explicit in this fixture.
    await db.photos.update(activePhoto!.id, {
      byte_size: 100,
      upload_state: 'pending',
      updated_at: '2026-11-10T00:00:00.000Z',
    })
    await db.photos.update(deletedPhoto!.id, {
      byte_size: 40,
      upload_state: 'error',
      updated_at: '2026-11-14T00:00:00.000Z',
    })
    await db.photos.update(extra[0]!.id, {
      byte_size: 200,
      upload_state: 'uploading',
      updated_at: '2026-11-13T00:00:00.000Z',
    })
    await db.entries.update(active.id, { updated_at: '2026-11-11T00:00:00.000Z' })
    await db.entries.update(deleted.id, { updated_at: '2026-11-12T00:00:00.000Z' })
    await db.outbox.clear()
    await db.outbox.bulkAdd([
      {
        id: 'mutation-collection',
        collection_id: collection.id,
        entity: 'collection',
        entity_id: collection.id,
        op: 'upsert',
        base_revision: null,
        fields: {},
        created_at: fixed,
        attempts: 0,
        in_flight: false,
        last_error: null,
        next_attempt_at: null,
      },
      {
        id: 'mutation-item',
        collection_id: collection.id,
        entity: 'item',
        entity_id: active.item_id,
        op: 'upsert',
        base_revision: null,
        fields: {},
        created_at: fixed,
        attempts: 0,
        in_flight: false,
        last_error: null,
        next_attempt_at: null,
      },
    ])

    const summary = await first(repo.watchCollectionSummary(collection.id))
    expect(summary).toMatchObject({
      collection: { id: collection.id, name: 'North shelf', folder: 'Temple 2', status: 'active' },
      entry_count: 1,
      photo_count: 1,
      incomplete_count: 0,
      needs_review_count: 0,
      deleted_entry_count: 1,
      pending_sync_count: 5,
      pending_upload_bytes: 340,
      quantity_by_unit: [{ unit: 'Boxes', total: '5', entry_count: 1 }],
      last_activity_at: fixed,
    })
    const listed = await first(repo.watchCollectionSummaries({ includeArchived: false }))
    expect(listed).toHaveLength(1)
    // The list and the single-collection watcher take different query paths; they must agree.
    expect(listed[0]).toEqual(summary)
    expect(await first(repo.watchCollectionSummaries({ includeArchived: true }))).toHaveLength(2)
    await db.delete()
  })
})
