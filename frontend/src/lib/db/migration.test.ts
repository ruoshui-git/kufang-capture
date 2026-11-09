import Dexie from 'dexie'
import { describe, expect, it } from 'vitest'
import { Blob as NodeBlobImpl } from 'node:buffer'
import { createRepo, getCaptureDb, readPhotoBlob } from './index'
import { sha256 } from '../photos'

const now = '2026-11-08T12:00:00.000Z'
const NodeBlob = NodeBlobImpl as unknown as typeof Blob

describe('v3 to v4 migration', () => {
  it('preserves rows and blobs while splitting shared fields out of entries and outbox', async () => {
    const name = `capture-v3-migration-${crypto.randomUUID()}`
    const old = new Dexie(name)
    old.version(1).stores({
      collections: 'id, status, storage_mode, updated_at',
      entries:
        'id, [collection_id+sequence_number], [collection_id+deleted_at], [collection_id+updated_at], collection_id',
      photos:
        'id, [entry_id+sort_order], entry_id, collection_id, [collection_id+deleted_at], [collection_id+captured_at], [entry_id+deleted_at]',
      photoBlobs: 'photo_id',
      outbox:
        'id, [collection_id+entity_id], [collection_id+entity+entity_id], next_attempt_at, collection_id',
      settings: 'key',
    })
    old.version(2).stores({ conflicts: 'id, collection_id, [entity+entity_id], created_at' })
    old
      .version(3)
      .stores({})
      .upgrade((tx) =>
        tx
          .table('photos')
          .toCollection()
          .modify((photo: Record<string, unknown>) => {
            photo.upload_attempts ??= 0
            photo.upload_next_attempt_at ??= null
          }),
      )
    await old.open()
    await old.table('collections').put({
      id: 'collection-1',
      name: 'Room',
      description: '',
      status: 'active',
      storage_mode: 'local_only',
      next_sequence_number: 3,
      sort_order: null,
      sync_consented_at: null,
      last_exported_at: null,
      archived_at: null,
      created_at: now,
      updated_at: now,
      revision: 3,
      server_revision: null,
      sync_state: 'local_only',
    })
    const entry = {
      id: 'entry-1',
      collection_id: 'collection-1',
      sequence_number: 2,
      title: 'Box',
      notes: 'Top shelf',
      expiration_date: null,
      dimensions: '',
      review_status: 'draft',
      quantity: '4',
      unit: 'boxes',
      count_detail: 'large',
      deleted_at: now,
      created_at: now,
      updated_at: now,
      revision: 7,
      server_revision: 5,
      sync_state: 'local_only',
    }
    await old.table('entries').put(entry)
    const makePhoto = (id: string) => ({
      id,
      entry_id: entry.id,
      collection_id: entry.collection_id,
      sort_order: id === 'photo-blob' ? 0 : 1,
      original_filename: `${id}.jpg`,
      mime_type: 'image/jpeg',
      byte_size: 3,
      width: null,
      height: null,
      sha256: 'a'.repeat(64),
      crc32: 1,
      captured_at: now,
      capture_source: 'photo_library',
      caption: '',
      is_cover: id === 'photo-blob',
      deleted_at: id === 'photo-bytes' ? now : null,
      upload_state: 'not_needed',
      server_storage_key: null,
      created_at: now,
      updated_at: now,
      revision: 1,
      server_revision: null,
      sync_state: 'local_only',
    })
    await old.table('photos').bulkPut([makePhoto('photo-blob'), makePhoto('photo-bytes')])
    const blobBytes = new Uint8Array([0, 1, 2])
    await old
      .table('photoBlobs')
      .put({ photo_id: 'photo-blob', original: new NodeBlob([blobBytes]), thumbnail: null })
    await old.table('photoBlobs').put({
      photo_id: 'photo-bytes',
      original: { kind: 'bytes', bytes: blobBytes.buffer, type: 'image/jpeg' },
      thumbnail: null,
    })
    await old.table('outbox').bulkPut([
      {
        id: 'mutation-create',
        collection_id: 'collection-1',
        entity: 'entry',
        entity_id: entry.id,
        op: 'upsert',
        base_revision: null,
        fields: { ...entry },
        created_at: now,
        attempts: 0,
        in_flight: false,
        last_error: null,
        next_attempt_at: null,
      },
      {
        id: 'mutation-update',
        collection_id: 'collection-1',
        entity: 'entry',
        entity_id: entry.id,
        op: 'upsert',
        base_revision: 5,
        fields: { title: 'Edited', quantity: '6' },
        created_at: now,
        attempts: 0,
        in_flight: false,
        last_error: null,
        next_attempt_at: null,
      },
      {
        id: 'mutation-photo',
        collection_id: 'collection-1',
        entity: 'photo',
        entity_id: 'photo-blob',
        op: 'upsert',
        base_revision: null,
        fields: { entry_id: entry.id, collection_id: 'collection-1', caption: 'x' },
        created_at: now,
        attempts: 0,
        in_flight: false,
        last_error: null,
        next_attempt_at: null,
      },
    ])
    await old.table('conflicts').put({
      id: 'conflict-1',
      collection_id: 'collection-1',
      entity: 'entry',
      entity_id: entry.id,
      fields: ['title', 'quantity'],
      local_values: { title: 'Local', quantity: '8' },
      server_values: { title: 'Server', quantity: '9' },
      server_revision: 6,
      created_at: now,
    })
    old.close()

    createRepo({ databaseName: name, binaryStorage: 'bytes' })
    const db = getCaptureDb(name)
    const migrated = await db.entries.get(entry.id)
    expect(migrated).toMatchObject({
      id: entry.id,
      item_id: entry.id,
      sequence_number: 2,
      quantity: '4',
      revision: 7,
    })
    expect(await db.items.get(entry.id)).toMatchObject({
      id: entry.id,
      title: 'Box',
      notes: 'Top shelf',
      revision: 7,
    })
    expect((await db.photos.toArray()).map((photo) => photo.item_id)).toEqual([entry.id, entry.id])
    for (const id of ['photo-blob', 'photo-bytes']) {
      const blob = (await readPhotoBlob(id, name))!.original
      expect([...new Uint8Array(await blob.arrayBuffer())]).toEqual([...blobBytes])
      expect(await sha256(blob)).toBe(await sha256(new Blob([blobBytes])))
    }
    const mutations = await db.outbox.toArray()
    expect(mutations.filter((row) => row.entity === 'item')).toHaveLength(2)
    expect(mutations.find((row) => row.id === 'mutation-update')?.fields).toEqual({ quantity: '6' })
    expect(mutations.find((row) => row.entity === 'photo')?.fields).toEqual({
      item_id: entry.id,
      caption: 'x',
    })
    expect(await db.conflicts.get('conflict-1')).toMatchObject({ entity: 'item', fields: ['title'] })
    const summary = await new Promise<{
      entry_count: number
      deleted_entry_count: number
      photo_count: number
      quantity_by_unit: unknown[]
    }>((resolve, reject) => {
      let sub: { unsubscribe(): void } | (() => void) | undefined
      sub = createRepo({ databaseName: name })
        .watchCollectionSummary('collection-1')
        .subscribe((value) => {
          if (value) {
            if (typeof sub === 'function') sub()
            else sub?.unsubscribe()
            resolve(value)
          }
        }, reject)
    })
    expect(summary).toMatchObject({
      entry_count: 0,
      deleted_entry_count: 1,
      photo_count: 0,
      quantity_by_unit: [],
    })
    await db.delete()
  })
})
