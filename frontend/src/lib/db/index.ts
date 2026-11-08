import Dexie, { liveQuery, type Table } from 'dexie'
import type {
  Repo,
  EntryQuery,
  EntryPatch,
  IncomingPhoto,
  NewCollectionInput,
  ClearCheck,
  StorageEstimate,
  Watchable,
} from '../repo'
import type {
  Collection,
  CollectionSummary,
  Entry,
  EntryRow,
  Id,
  OutboxEntity,
  OutboxItem,
  OutboxOp,
  Photo,
  PhotoBlob,
  Setting,
} from '../types'
import { SETTING_KEYS, formatSequence } from '../types'
import { createId } from '../ids'
import { addDecimals, isIncomplete, normalizeUnit } from '../summary'
import {
  configurePhotoBlobLoader,
  crc32,
  defaultImageProcessor,
  sha256,
  type ImageProcessor,
} from '../photos'

interface RepoOptions {
  databaseName?: string
  imageProcessor?: ImageProcessor
  now?: () => Date
}

/**
 * Schema v1: collections by id/status; entries by id, collection/sequence (unique),
 * collection/deleted, and collection/update; photos by id, entry/order, collection,
 * collection/deleted and collection/capture; blobs by photo id; outbox by id,
 * collection/entity, and retry time; settings by key. Future versions add migrations.
 */
class CaptureDb extends Dexie {
  collections!: Table<Collection, Id>
  entries!: Table<Entry, Id>
  photos!: Table<Photo, Id>
  photoBlobs!: Table<PhotoBlob, Id>
  outbox!: Table<OutboxItem, Id>
  settings!: Table<Setting, string>
  constructor(name: string) {
    super(name)
    this.version(1).stores({
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
  }
}

export function createRepo(options: RepoOptions = {}): Repo {
  const db = new CaptureDb(options.databaseName ?? 'kufang-capture')
  const imageProcessor = options.imageProcessor ?? defaultImageProcessor
  const now = options.now ?? (() => new Date())
  const stamp = () => now().toISOString()
  configurePhotoBlobLoader((id) => db.photoBlobs.get(id))

  const enqueue = async (
    collection: Collection,
    entity: OutboxEntity,
    record: Collection | Entry | Photo,
    op: OutboxOp,
    fields: Record<string, unknown>,
  ) => {
    if (collection.storage_mode !== 'synced') return
    const matches = await db.outbox
      .where('[collection_id+entity+entity_id]')
      .equals([collection.id, entity, record.id])
      .toArray()
    const existing = matches.find((item) => !item.in_flight)
    const at = stamp()
    if (existing) {
      await db.outbox.put({
        ...existing,
        op: existing.op === 'upsert' && op === 'upsert' ? 'upsert' : op,
        fields: { ...existing.fields, ...fields },
        base_revision: existing.base_revision,
        created_at: existing.created_at,
      })
    } else {
      await db.outbox.add({
        id: createId(),
        collection_id: collection.id,
        entity,
        entity_id: record.id,
        op,
        base_revision: record.server_revision,
        fields,
        created_at: at,
        attempts: 0,
        in_flight: false,
        last_error: null,
        next_attempt_at: null,
      })
    }
  }
  const touchCollection = async (collection: Collection, at: string) => {
    const updated = {
      ...collection,
      updated_at: at,
      revision: collection.revision + 1,
      sync_state: collection.storage_mode === 'local_only' ? ('local_only' as const) : ('pending' as const),
    }
    await db.collections.put(updated)
    return updated
  }
  const saveEntry = async (entry: Entry, patch: Record<string, unknown>, op: OutboxOp = 'upsert') => {
    const collection = await db.collections.get(entry.collection_id)
    if (!collection) throw new Error('Collection not found')
    const at = stamp()
    const saved = {
      ...entry,
      updated_at: at,
      revision: entry.revision + 1,
      sync_state: collection.storage_mode === 'local_only' ? ('local_only' as const) : ('pending' as const),
    }
    await db.entries.put(saved)
    const touched = await touchCollection(collection, at)
    await enqueue(touched, 'entry', saved, op, patch)
    return saved
  }
  const activePhotos = async (entryId: Id) =>
    db.photos
      .where('entry_id')
      .equals(entryId)
      .toArray()
      .then((rows) =>
        rows.filter((photo) => photo.deleted_at === null).sort((a, b) => a.sort_order - b.sort_order),
      )
  const validateCover = async (entryId: Id, collection: Collection) => {
    const rows = await db.photos.where('entry_id').equals(entryId).toArray()
    const active = rows
      .filter((photo) => photo.deleted_at === null)
      .sort((a, b) => a.sort_order - b.sort_order)
    const coverId = active.find((photo) => photo.is_cover)?.id ?? active[0]?.id
    for (const photo of rows) {
      const cover = photo.id === coverId
      if (photo.is_cover !== cover) {
        const updated = {
          ...photo,
          is_cover: cover,
          updated_at: stamp(),
          revision: photo.revision + 1,
          sync_state:
            collection.storage_mode === 'local_only' ? ('local_only' as const) : ('pending' as const),
        }
        await db.photos.put(updated)
        await enqueue(collection, 'photo', updated, 'upsert', { is_cover: cover })
      }
    }
  }
  const summaryFor = async (collection: Collection): Promise<CollectionSummary> => {
    const [entries, photos, outbox] = await Promise.all([
      db.entries.where('collection_id').equals(collection.id).toArray(),
      db.photos.where('collection_id').equals(collection.id).toArray(),
      db.outbox.where('collection_id').equals(collection.id).toArray(),
    ])
    const activeEntries = entries.filter((entry) => entry.deleted_at === null)
    const activePhotos = photos.filter(
      (photo) =>
        photo.deleted_at === null &&
        entries.some((entry) => entry.id === photo.entry_id && entry.deleted_at === null),
    )
    const quantities = new Map<
      string,
      { unit: string; total: string; entry_count: number; updated: string }
    >()
    for (const entry of activeEntries) {
      if (entry.quantity === null || entry.quantity.trim() === '') continue
      const key = normalizeUnit(entry.unit)
      const current = quantities.get(key)
      if (!current)
        quantities.set(key, {
          unit: entry.unit.trim(),
          total: entry.quantity.trim(),
          entry_count: 1,
          updated: entry.updated_at,
        })
      else {
        current.total = addDecimals(current.total, entry.quantity.trim())
        current.entry_count++
        if (entry.updated_at >= current.updated) {
          current.unit = entry.unit.trim()
          current.updated = entry.updated_at
        }
      }
    }
    const photoByEntry = new Map<Id, number>()
    for (const photo of activePhotos)
      photoByEntry.set(photo.entry_id, (photoByEntry.get(photo.entry_id) ?? 0) + 1)
    const pendingUpload = photos.filter((photo) =>
      ['pending', 'uploading', 'error'].includes(photo.upload_state),
    )
    const latest =
      [
        collection.updated_at,
        ...entries.map((entry) => entry.updated_at),
        ...photos.map((photo) => photo.updated_at),
      ]
        .sort()
        .at(-1) ?? collection.updated_at
    return {
      collection,
      entry_count: activeEntries.length,
      photo_count: activePhotos.length,
      incomplete_count: activeEntries.filter((entry) =>
        isIncomplete(entry, (photoByEntry.get(entry.id) ?? 0) > 0),
      ).length,
      needs_review_count: activeEntries.filter((entry) => entry.review_status === 'needs_review').length,
      deleted_entry_count: entries.filter((entry) => entry.deleted_at !== null).length,
      pending_sync_count: outbox.length + pendingUpload.length,
      pending_upload_bytes: pendingUpload.reduce((sum, photo) => sum + photo.byte_size, 0),
      quantity_by_unit: [...quantities.values()].map(({ unit, total, entry_count }) => ({
        unit,
        total,
        entry_count,
      })),
      last_activity_at: latest,
    }
  }

  const repo: Repo = {
    watchCollectionSummaries: ({ includeArchived }) =>
      liveQuery(async () => {
        const collections = await db.collections.toArray()
        return Promise.all(
          collections
            .filter((collection) => includeArchived || collection.status === 'active')
            .sort(
              (a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0) || b.updated_at.localeCompare(a.updated_at),
            )
            .map(summaryFor),
        )
      }) as Watchable<CollectionSummary[]>,
    watchCollectionSummary: (id) =>
      liveQuery(async () => {
        const collection = await db.collections.get(id)
        return collection ? summaryFor(collection) : undefined
      }) as Watchable<CollectionSummary | undefined>,
    getCollection: (id) => db.collections.get(id),
    createCollection: async (input: NewCollectionInput) => {
      const at = stamp()
      const collection: Collection = {
        id: createId(),
        name: input.name.trim(),
        description: input.description ?? '',
        status: 'active',
        storage_mode: input.storage_mode,
        next_sequence_number: 1,
        sort_order: null,
        sync_consented_at: null,
        last_exported_at: null,
        archived_at: null,
        created_at: at,
        updated_at: at,
        revision: 1,
        server_revision: null,
        sync_state: input.storage_mode === 'local_only' ? 'local_only' : 'pending',
      }
      await db.transaction('rw', db.collections, db.outbox, async () => {
        await db.collections.add(collection)
        await enqueue(collection, 'collection', collection, 'upsert', { ...collection })
      })
      return collection
    },
    updateCollection: async (id, patch) =>
      db.transaction('rw', db.collections, db.outbox, async () => {
        const current = await db.collections.get(id)
        if (!current) throw new Error('Collection not found')
        const at = stamp()
        const saved = {
          ...current,
          ...patch,
          updated_at: at,
          revision: current.revision + 1,
          sync_state: current.storage_mode === 'local_only' ? ('local_only' as const) : ('pending' as const),
        }
        await db.collections.put(saved)
        await enqueue(saved, 'collection', saved, 'upsert', patch)
      }),
    archiveCollection: async (id) => {
      const current = await db.collections.get(id)
      if (!current) throw new Error('Collection not found')
      await db.transaction('rw', db.collections, db.outbox, async () => {
        const at = stamp()
        const saved = {
          ...current,
          status: 'archived' as const,
          archived_at: at,
          updated_at: at,
          revision: current.revision + 1,
          sync_state: current.storage_mode === 'local_only' ? ('local_only' as const) : ('pending' as const),
        }
        await db.collections.put(saved)
        await enqueue(saved, 'collection', saved, 'upsert', { status: 'archived', archived_at: at })
      })
    },
    unarchiveCollection: async (id) => {
      const current = await db.collections.get(id)
      if (!current) throw new Error('Collection not found')
      await db.transaction('rw', db.collections, db.outbox, async () => {
        const at = stamp()
        const saved = {
          ...current,
          status: 'active' as const,
          archived_at: null,
          updated_at: at,
          revision: current.revision + 1,
          sync_state: current.storage_mode === 'local_only' ? ('local_only' as const) : ('pending' as const),
        }
        await db.collections.put(saved)
        await enqueue(saved, 'collection', saved, 'upsert', { status: 'active', archived_at: null })
      })
    },
    markExported: async (ids, at = stamp()) =>
      db.transaction('rw', db.collections, async () => {
        for (const id of ids) {
          const current = await db.collections.get(id)
          if (current) await db.collections.put({ ...current, last_exported_at: at })
        }
      }),
    checkClearCollection: async (id): Promise<ClearCheck> => {
      const collection = await db.collections.get(id)
      if (!collection) throw new Error('Collection not found')
      const [entries, photos] = await Promise.all([
        db.entries.where('collection_id').equals(id).toArray(),
        db.photos.where('collection_id').equals(id).toArray(),
      ])
      const latest =
        [
          collection.updated_at,
          ...entries.map((item) => item.updated_at),
          ...photos.map((item) => item.updated_at),
        ]
          .sort()
          .at(-1) ?? collection.updated_at
      const unexported = !collection.last_exported_at || collection.last_exported_at < latest
      const pending =
        collection.storage_mode === 'synced'
          ? photos.filter((photo) => ['pending', 'uploading', 'error'].includes(photo.upload_state)).length
          : 0
      const reasons: string[] = []
      if (unexported) reasons.push('Export the collection after its latest change before clearing it.')
      if (pending) reasons.push(`${pending} photo${pending === 1 ? '' : 's'} still need upload.`)
      return {
        allowed: reasons.length === 0,
        reasons,
        unexported_changes: unexported,
        pending_uploads: pending,
        last_exported_at: collection.last_exported_at,
      }
    },
    clearCollection: async (id, confirmName) => {
      await db.transaction(
        'rw',
        db.collections,
        db.entries,
        db.photos,
        db.photoBlobs,
        db.outbox,
        async () => {
          const collection = await db.collections.get(id)
          if (!collection) throw new Error('Collection not found')
          if (confirmName !== collection.name) throw new Error('Collection name confirmation did not match.')
          const [entries, photos] = await Promise.all([
            db.entries.where('collection_id').equals(id).toArray(),
            db.photos.where('collection_id').equals(id).toArray(),
          ])
          const latest =
            [
              collection.updated_at,
              ...entries.map((item) => item.updated_at),
              ...photos.map((item) => item.updated_at),
            ]
              .sort()
              .at(-1) ?? collection.updated_at
          const unexported = !collection.last_exported_at || collection.last_exported_at < latest
          const pending =
            collection.storage_mode === 'synced'
              ? photos.filter((photo) => ['pending', 'uploading', 'error'].includes(photo.upload_state))
                  .length
              : 0
          if (unexported || pending) {
            const reasons = [
              ...(unexported ? ['Export the collection after its latest change before clearing it.'] : []),
              ...(pending ? [`${pending} photo${pending === 1 ? '' : 's'} still need upload.`] : []),
            ]
            throw new Error(reasons.join(' '))
          }
          const entryIds = await db.entries.where('collection_id').equals(id).primaryKeys()
          const photoIds = await db.photos.where('collection_id').equals(id).primaryKeys()
          await db.photoBlobs.bulkDelete(photoIds)
          await db.photos.bulkDelete(photoIds)
          await db.entries.bulkDelete(entryIds)
          await db.outbox.where('collection_id').equals(id).delete()
          await db.collections.delete(id)
        },
      )
    },
    watchEntryRows: (collectionId, query) =>
      liveQuery(async () => {
        const [entries, photos, outbox] = await Promise.all([
          db.entries.where('collection_id').equals(collectionId).toArray(),
          db.photos.where('collection_id').equals(collectionId).toArray(),
          db.outbox.where('collection_id').equals(collectionId).toArray(),
        ])
        const activePhotos = photos.filter((photo) => photo.deleted_at === null)
        const sortedEntries = entries
          .filter((entry) =>
            query.filter === 'deleted' ? entry.deleted_at !== null : entry.deleted_at === null,
          )
          .sort((a, b) =>
            query.sort === 'newest'
              ? b.sequence_number - a.sequence_number
              : a.sequence_number - b.sequence_number,
          )
        const term = query.search.trim().toLocaleLowerCase()
        const rows: EntryRow[] = sortedEntries
          .map((entry) => {
            const entryPhotos = activePhotos.filter((photo) => photo.entry_id === entry.id)
            const allEntryPhotos = photos.filter((photo) => photo.entry_id === entry.id)
            const incomplete = isIncomplete(entry, entryPhotos.length > 0)
            const photoPending = allEntryPhotos.some((photo) =>
              ['pending', 'uploading', 'error'].includes(photo.upload_state),
            )
            const photoIds = new Set(allEntryPhotos.map((photo) => photo.id))
            const queued = outbox.some((item) => item.entity_id === entry.id || photoIds.has(item.entity_id))
            return {
              entry,
              photo_count: entryPhotos.length,
              recent_photos: entryPhotos
                .sort((a, b) => b.captured_at.localeCompare(a.captured_at) || b.id.localeCompare(a.id))
                .slice(0, 3),
              is_incomplete: incomplete,
              pending_sync: queued || photoPending,
            }
          })
          .filter((row) =>
            query.filter === 'incomplete'
              ? row.is_incomplete
              : query.filter === 'pending_sync'
                ? row.pending_sync
                : true,
          )
        return !term
          ? rows
          : rows.filter(({ entry }) =>
              [
                String(entry.sequence_number),
                formatSequence(entry.sequence_number),
                entry.title,
                entry.notes,
                entry.count_detail,
                entry.unit,
              ].some((value) => value.toLocaleLowerCase().includes(term)),
            )
      }) as Watchable<EntryRow[]>,
    watchEntry: (id) => liveQuery(() => db.entries.get(id)) as Watchable<Entry | undefined>,
    getEntry: (id) => db.entries.get(id),
    createEntry: async (collectionId, init = {}) =>
      db.transaction('rw', db.collections, db.entries, db.outbox, db.settings, async () => {
        const collection = await db.collections.get(collectionId)
        if (!collection) throw new Error('Collection not found')
        const at = stamp()
        const unit = init.unit ?? (await repo.getSetting(SETTING_KEYS.lastUnit, ''))
        const entry: Entry = {
          id: createId(),
          collection_id: collectionId,
          sequence_number: collection.next_sequence_number,
          title: init.title ?? '',
          quantity: init.quantity ?? null,
          unit,
          count_detail: init.count_detail ?? '',
          notes: init.notes ?? '',
          expiration_date: init.expiration_date ?? null,
          dimensions: init.dimensions ?? '',
          review_status: init.review_status ?? 'draft',
          deleted_at: null,
          created_at: at,
          updated_at: at,
          revision: 1,
          server_revision: null,
          sync_state: collection.storage_mode === 'local_only' ? 'local_only' : 'pending',
        }
        const updatedCollection = {
          ...collection,
          next_sequence_number: collection.next_sequence_number + 1,
          updated_at: at,
          revision: collection.revision + 1,
          sync_state:
            collection.storage_mode === 'local_only' ? ('local_only' as const) : ('pending' as const),
        }
        await db.collections.put(updatedCollection)
        await db.entries.add(entry)
        await enqueue(updatedCollection, 'entry', entry, 'upsert', { ...entry })
        return entry
      }),
    updateEntry: async (id, patch) =>
      db.transaction('rw', db.collections, db.entries, db.outbox, db.settings, async () => {
        const entry = await db.entries.get(id)
        if (!entry) throw new Error('Entry not found')
        const saved = await saveEntry({ ...entry, ...patch }, patch as Record<string, unknown>)
        if (typeof patch.unit === 'string' && patch.unit.trim())
          await db.settings.put({ key: SETTING_KEYS.lastUnit, value: patch.unit })
        void saved
      }),
    deleteEntry: async (id) =>
      db.transaction('rw', db.collections, db.entries, db.outbox, async () => {
        const entry = await db.entries.get(id)
        if (!entry) return
        const deletedAt = stamp()
        await saveEntry({ ...entry, deleted_at: deletedAt }, { deleted_at: deletedAt }, 'delete')
      }),
    restoreEntry: async (id) =>
      db.transaction('rw', db.collections, db.entries, db.outbox, async () => {
        const entry = await db.entries.get(id)
        if (!entry) return
        await saveEntry({ ...entry, deleted_at: null }, { deleted_at: null }, 'restore')
      }),
    getAdjacentEntryIds: async (entryId, sort) => {
      const entry = await db.entries.get(entryId)
      if (!entry) return { prev: null, next: null }
      const rows = (await db.entries.where('collection_id').equals(entry.collection_id).toArray())
        .filter((row) => row.deleted_at === null)
        .sort((a, b) =>
          sort === 'newest' ? b.sequence_number - a.sequence_number : a.sequence_number - b.sequence_number,
        )
      const i = rows.findIndex((row) => row.id === entryId)
      return { prev: rows[i - 1]?.id ?? null, next: rows[i + 1]?.id ?? null }
    },
    addPhotos: async (entryId, incoming) => {
      const entry = await db.entries.get(entryId)
      if (!entry) throw new Error('Entry not found')
      const collection = await db.collections.get(entry.collection_id)
      if (!collection) throw new Error('Collection not found')
      const at = stamp()
      const prepared = await Promise.all(
        incoming.map(async (photo) => ({
          digest: await sha256(photo.blob),
          checksum: await crc32(photo.blob),
        })),
      )
      const created = await db.transaction(
        'rw',
        db.collections,
        db.entries,
        db.photos,
        db.photoBlobs,
        db.outbox,
        async () => {
          // Read inside the transaction so rapid concurrent captures get distinct
          // sort orders and exactly one cover.
          const existing = await activePhotos(entryId)
          const made: Photo[] = []
          for (const [index, photo] of incoming.entries()) {
            const capturedAt = photo.captured_at ?? at
            const { digest, checksum } = prepared[index]!
            const mime = photo.blob.type || mimeFromFilename(photo.filename)
            const filename = photo.filename || generatedFilename(capturedAt, mime)
            const item: Photo = {
              id: createId(),
              entry_id: entryId,
              collection_id: collection.id,
              sort_order: existing.length + index,
              original_filename: filename,
              mime_type: mime,
              byte_size: photo.blob.size,
              width: null,
              height: null,
              sha256: digest,
              crc32: checksum,
              captured_at: capturedAt,
              capture_source: photo.source,
              caption: '',
              is_cover: existing.length === 0 && index === 0,
              deleted_at: null,
              upload_state: collection.storage_mode === 'local_only' ? 'not_needed' : 'pending',
              server_storage_key: null,
              created_at: at,
              updated_at: at,
              revision: 1,
              server_revision: null,
              sync_state: collection.storage_mode === 'local_only' ? 'local_only' : 'pending',
            }
            await db.photos.add(item)
            await db.photoBlobs.add({ photo_id: item.id, original: photo.blob, thumbnail: null })
            await enqueue(collection, 'photo', item, 'upsert', { ...item })
            made.push(item)
          }
          const touched = await touchCollection(collection, at)
          const fresh = await db.entries.get(entryId)
          if (fresh)
            await db.entries.put({
              ...fresh,
              updated_at: at,
              revision: fresh.revision + 1,
              sync_state: collection.storage_mode === 'local_only' ? 'local_only' : 'pending',
            })
          return made
        },
      )
      for (const item of created) {
        try {
          const processed = await imageProcessor(incoming[created.indexOf(item)]!.blob)
          await db.transaction('rw', db.photos, db.photoBlobs, db.collections, db.outbox, async () => {
            const current = await db.photos.get(item.id)
            const currentCollection = await db.collections.get(collection.id)
            const blob = await db.photoBlobs.get(item.id)
            if (!current || !currentCollection || !blob) return
            const saved = {
              ...current,
              width: processed.width,
              height: processed.height,
              updated_at: stamp(),
              revision: current.revision + 1,
              sync_state:
                currentCollection.storage_mode === 'local_only'
                  ? ('local_only' as const)
                  : ('pending' as const),
            }
            await db.photos.put(saved)
            await db.photoBlobs.put({ ...blob, thumbnail: processed.thumbnail })
            await enqueue(currentCollection, 'photo', saved, 'upsert', {
              width: saved.width,
              height: saved.height,
            })
          })
        } catch {
          /* Original and metadata were already durably committed; thumbnail can be retried later. */
        }
      }
      return created
    },
    watchPhotos: (entryId, opts = {}) =>
      liveQuery(async () =>
        (await db.photos.where('entry_id').equals(entryId).toArray())
          .filter((photo) => opts.includeDeleted || photo.deleted_at === null)
          .sort((a, b) => a.sort_order - b.sort_order),
      ) as Watchable<Photo[]>,
    updatePhoto: async (id, patch) =>
      db.transaction('rw', db.photos, db.collections, db.outbox, async () => {
        const photo = await db.photos.get(id)
        if (!photo) throw new Error('Photo not found')
        const collection = await db.collections.get(photo.collection_id)
        if (!collection) throw new Error('Collection not found')
        const saved = {
          ...photo,
          ...patch,
          updated_at: stamp(),
          revision: photo.revision + 1,
          sync_state:
            collection.storage_mode === 'local_only' ? ('local_only' as const) : ('pending' as const),
        }
        await db.photos.put(saved)
        await touchCollection(collection, saved.updated_at)
        await enqueue(collection, 'photo', saved, 'upsert', patch)
      }),
    setCoverPhoto: async (id) =>
      db.transaction('rw', db.photos, db.collections, db.outbox, async () => {
        const photo = await db.photos.get(id)
        if (!photo || photo.deleted_at) throw new Error('Photo not found')
        const collection = await db.collections.get(photo.collection_id)
        if (!collection) throw new Error('Collection not found')
        const rows = await db.photos.where('entry_id').equals(photo.entry_id).toArray()
        for (const current of rows) {
          const cover = current.id === id
          if (current.is_cover !== cover) {
            const saved = {
              ...current,
              is_cover: cover,
              updated_at: stamp(),
              revision: current.revision + 1,
              sync_state:
                collection.storage_mode === 'local_only' ? ('local_only' as const) : ('pending' as const),
            }
            await db.photos.put(saved)
            await enqueue(collection, 'photo', saved, 'upsert', { is_cover: cover })
          }
        }
        await touchCollection(collection, stamp())
      }),
    reorderPhotos: async (entryId, orderedIds) =>
      db.transaction('rw', db.photos, db.entries, db.collections, db.outbox, async () => {
        const entry = await db.entries.get(entryId)
        if (!entry) throw new Error('Entry not found')
        const collection = await db.collections.get(entry.collection_id)
        if (!collection) throw new Error('Collection not found')
        const rows = await db.photos.where('entry_id').equals(entryId).toArray()
        if (
          orderedIds.length !== rows.length ||
          new Set(orderedIds).size !== rows.length ||
          orderedIds.some((id) => !rows.some((row) => row.id === id))
        )
          throw new Error('Photo order must include every photo exactly once.')
        for (const [index, id] of orderedIds.entries()) {
          const photo = rows.find((row) => row.id === id)!
          if (photo.sort_order !== index) {
            const saved = {
              ...photo,
              sort_order: index,
              updated_at: stamp(),
              revision: photo.revision + 1,
              sync_state:
                collection.storage_mode === 'local_only' ? ('local_only' as const) : ('pending' as const),
            }
            await db.photos.put(saved)
            await enqueue(collection, 'photo', saved, 'upsert', { sort_order: index })
          }
        }
        await touchCollection(collection, stamp())
      }),
    deletePhoto: async (id) =>
      db.transaction('rw', db.photos, db.collections, db.outbox, async () => {
        const photo = await db.photos.get(id)
        if (!photo) return
        const collection = await db.collections.get(photo.collection_id)
        if (!collection) return
        const saved = {
          ...photo,
          deleted_at: stamp(),
          updated_at: stamp(),
          revision: photo.revision + 1,
          sync_state:
            collection.storage_mode === 'local_only' ? ('local_only' as const) : ('pending' as const),
        }
        await db.photos.put(saved)
        await touchCollection(collection, saved.updated_at)
        await enqueue(collection, 'photo', saved, 'delete', { deleted_at: saved.deleted_at })
        await validateCover(photo.entry_id, collection)
      }),
    restorePhoto: async (id) =>
      db.transaction('rw', db.photos, db.collections, db.outbox, async () => {
        const photo = await db.photos.get(id)
        if (!photo) return
        const collection = await db.collections.get(photo.collection_id)
        if (!collection) return
        const saved = {
          ...photo,
          deleted_at: null,
          updated_at: stamp(),
          revision: photo.revision + 1,
          sync_state:
            collection.storage_mode === 'local_only' ? ('local_only' as const) : ('pending' as const),
        }
        await db.photos.put(saved)
        await touchCollection(collection, saved.updated_at)
        await enqueue(collection, 'photo', saved, 'restore', { deleted_at: null })
        await validateCover(photo.entry_id, collection)
      }),
    getPhotoBlob: (id) => db.photoBlobs.get(id),
    watchDeletedPhotos: (collectionId) =>
      liveQuery(async () => {
        const [photos, entries] = await Promise.all([
          db.photos.where('collection_id').equals(collectionId).toArray(),
          db.entries.where('collection_id').equals(collectionId).toArray(),
        ])
        const deletedEntries = new Set(
          entries.filter((entry) => entry.deleted_at !== null).map((entry) => entry.id),
        )
        return photos
          .filter((photo) => photo.deleted_at !== null && !deletedEntries.has(photo.entry_id))
          .sort((a, b) => b.updated_at.localeCompare(a.updated_at))
      }) as Watchable<Photo[]>,
    getSetting: async <T>(key: string, fallback: T): Promise<T> =>
      ((await db.settings.get(key))?.value as T) ?? fallback,
    setSetting: async (key, value) => {
      await db.transaction('rw', db.settings, async () => {
        await db.settings.put({ key, value })
      })
    },
    estimateStorage: async (): Promise<StorageEstimate> => {
      try {
        const storage = navigator.storage
        if (!storage) return { usage: null, quota: null, persisted: null }
        const [estimate, persisted] = await Promise.all([storage.estimate(), storage.persisted()])
        return { usage: estimate.usage ?? null, quota: estimate.quota ?? null, persisted }
      } catch {
        return { usage: null, quota: null, persisted: null }
      }
    },
    requestPersistentStorage: async () => {
      try {
        return navigator.storage?.persist ? await navigator.storage.persist() : false
      } catch {
        return false
      }
    },
  }
  return repo
}

function mimeFromFilename(filename = ''): string {
  const ext = filename.toLowerCase().split('.').at(-1)
  return (
    (
      {
        jpg: 'image/jpeg',
        jpeg: 'image/jpeg',
        png: 'image/png',
        webp: 'image/webp',
        heic: 'image/heic',
        gif: 'image/gif',
      } as Record<string, string>
    )[ext ?? ''] ?? 'application/octet-stream'
  )
}
function generatedFilename(at: string, mime: string): string {
  const compact = at.replace(/[-:.TZ]/g, '').slice(0, 14)
  const ext =
    mime === 'image/png' ? 'png' : mime === 'image/webp' ? 'webp' : mime === 'image/heic' ? 'heic' : 'jpg'
  return `IMG_${compact}.${ext}`
}

export const repo: Repo = createRepo()
