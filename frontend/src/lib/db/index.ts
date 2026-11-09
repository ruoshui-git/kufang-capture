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
  EntryView,
  Id,
  Item,
  OutboxEntity,
  OutboxItem,
  OutboxOp,
  Photo,
  PhotoBlob,
  Setting,
  StorageMode,
} from '../types'
import { ITEM_FIELDS, SETTING_KEYS, formatSequence } from '../types'
import { createId } from '../ids'
import { addDecimals, isIncomplete, normalizeUnit } from '../summary'
import {
  configurePhotoBlobLoader,
  crc32,
  defaultImageProcessor,
  invalidateThumbnail,
  readBlob,
  sha256,
  type ImageProcessor,
} from '../photos'

interface RepoOptions {
  databaseName?: string
  imageProcessor?: ImageProcessor
  now?: () => Date
  /** 'bytes' forces the no-Blob storage path (tests; browsers are detected automatically). */
  binaryStorage?: 'auto' | 'bytes'
}

interface PhotoWithUploadRetry extends Photo {
  upload_attempts?: number
  upload_next_attempt_at?: string | null
}

/**
 * Schema v1: collections by id/status; entries by id, collection/sequence (unique),
 * collection/deleted, and collection/update; photos by id, entry/order, collection,
 * collection/deleted and collection/capture; blobs by photo id; outbox by id,
 * collection/entity, and retry time; settings by key. Future versions add migrations.
 */
// Stored shape; see StoredPhotoBlob below (Blob or bytes, decoded on read).
type StoredPhotoBlobRow = {
  photo_id: Id
  original: Blob | { kind: 'bytes'; bytes: ArrayBuffer; type: string }
  thumbnail: Blob | { kind: 'bytes'; bytes: ArrayBuffer; type: string } | null
}
class CaptureDb extends Dexie {
  collections!: Table<Collection, Id>
  entries!: Table<Entry, Id>
  photos!: Table<PhotoWithUploadRetry, Id>
  photoBlobs!: Table<StoredPhotoBlobRow, Id>
  outbox!: Table<OutboxItem, Id>
  settings!: Table<Setting, string>
  conflicts!: Table<import('../sync/api').SyncConflict, Id>
  items!: Table<Item, Id>
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
    this.version(2).stores({
      conflicts: 'id, collection_id, [entity+entity_id], created_at',
    })
    this.version(3)
      .stores({})
      .upgrade((transaction) =>
        transaction
          .table('photos')
          .toCollection()
          .modify((photo: Photo & { upload_attempts?: number; upload_next_attempt_at?: string | null }) => {
            photo.upload_attempts ??= 0
            photo.upload_next_attempt_at ??= null
          }),
      )
    this.version(4)
      .stores({
        collections: 'id, status, storage_mode, updated_at',
        items: 'id, updated_at',
        entries:
          'id, [collection_id+sequence_number], [collection_id+deleted_at], [collection_id+updated_at], collection_id, item_id, [collection_id+item_id]',
        photos: 'id, item_id, [item_id+sort_order], [item_id+deleted_at], [item_id+captured_at]',
        photoBlobs: 'photo_id',
        outbox:
          'id, [collection_id+entity_id], [collection_id+entity+entity_id], [entity+entity_id], next_attempt_at, collection_id',
        settings: 'key',
        conflicts: 'id, collection_id, [entity+entity_id], created_at',
      })
      .upgrade(async (tx) => {
        const entries = tx.table('entries')
        const photos = tx.table('photos')
        const items = tx.table('items')
        const outbox = tx.table('outbox')
        const conflicts = tx.table('conflicts')
        const entryRows = await entries.toArray()
        const itemKeys = ['title', 'notes', 'expiration_date', 'dimensions', 'review_status']
        for (const row of entryRows) {
          const shared: Record<string, unknown> = {}
          for (const key of itemKeys) {
            shared[key] = row[key]
            delete row[key]
          }
          await items.put({
            id: row.id,
            ...shared,
            created_at: row.created_at,
            updated_at: row.updated_at,
            revision: row.revision,
            server_revision: row.server_revision,
            sync_state: row.sync_state,
          })
          row.item_id = row.id
          await entries.put(row)
        }
        await photos.toCollection().modify((photo: Record<string, unknown>) => {
          photo.item_id = photo.entry_id
          delete photo.entry_id
          delete photo.collection_id
        })
        for (const mutation of await outbox.toArray()) {
          if (mutation.entity === 'entry') {
            const fields = { ...mutation.fields }
            const shared: Record<string, unknown> = Object.fromEntries(
              itemKeys.flatMap((key: string) => (key in fields ? [[key, fields[key]]] : [])),
            )
            for (const key of itemKeys) delete fields[key]
            if (mutation.base_revision === null) {
              const record = entryRows.find((entry) => entry.id === mutation.entity_id)
              if (record) {
                const original = await tx.table('items').get(mutation.entity_id)
                await outbox.add({
                  ...mutation,
                  id: createId(),
                  entity: 'item',
                  entity_id: mutation.entity_id,
                  fields: original,
                })
                await outbox.put({ ...mutation, fields: { ...record, item_id: record.id } })
              }
            } else if (Object.keys(shared).length) {
              await outbox.add({ ...mutation, id: createId(), entity: 'item', fields: shared })
              if (Object.keys(fields).length) await outbox.put({ ...mutation, fields })
              else if (mutation.op === 'upsert') await outbox.delete(mutation.id)
            }
          } else if (mutation.entity === 'photo') {
            const fields = { ...mutation.fields }
            if ('entry_id' in fields) fields.item_id = fields.entry_id
            delete fields.entry_id
            delete fields.collection_id
            await outbox.put({ ...mutation, fields })
          }
        }
        for (const conflict of await conflicts.toArray()) {
          if (conflict.entity !== 'entry') continue
          const shared = itemKeys.filter(
            (key) => key in conflict.local_values || key in conflict.server_values,
          )
          if (!shared.length) continue
          const entryFields = conflict.fields.filter((key: string) => !shared.includes(key))
          if (entryFields.length) {
            const entryKeys = entryFields
            await conflicts.add({
              ...conflict,
              id: createId(),
              entity: 'entry',
              fields: entryFields,
              local_values: Object.fromEntries(
                entryKeys.flatMap((key: string) =>
                  key in conflict.local_values ? [[key, conflict.local_values[key]]] : [],
                ),
              ),
              server_values: Object.fromEntries(
                entryKeys.flatMap((key: string) =>
                  key in conflict.server_values ? [[key, conflict.server_values[key]]] : [],
                ),
              ),
            })
          }
          await conflicts.put({
            ...conflict,
            entity: 'item',
            local_values: Object.fromEntries(
              shared.flatMap((key) =>
                key in conflict.local_values ? [[key, conflict.local_values[key]]] : [],
              ),
            ),
            server_values: Object.fromEntries(
              shared.flatMap((key) =>
                key in conflict.server_values ? [[key, conflict.server_values[key]]] : [],
              ),
            ),
            fields: conflict.fields.filter((key: string) => shared.includes(key)),
          })
        }
      })
  }
}

/** Shared schema accessor for the sync engine and repository. */
export function getCaptureDb(name = 'kufang-capture'): CaptureDb {
  return new CaptureDb(name)
}

/** Returns whether this device still has the original bytes for a photo. */
/**
 * Some browsers cannot store Blobs in IndexedDB (Safari Private Browsing, WebKit ephemeral
 * contexts). Photos are then stored as raw bytes plus their type: the same bytes, so originals stay
 * exact. Callers always receive Blobs via decodePhotoBlob/readPhotoBlob.
 */
type StoredBytes = { kind: 'bytes'; bytes: ArrayBuffer; type: string }
type StoredBinary = Blob | StoredBytes
type StoredPhotoBlob = { photo_id: Id; original: StoredBinary; thumbnail: StoredBinary | null }
const blobSupport = new WeakMap<Dexie, Promise<boolean>>()
// Probed once per database with a slice of a real photo (same Blob implementation as the data).
function blobStorageSupported(db: CaptureDb, sample: Blob): Promise<boolean> {
  let probe = blobSupport.get(db)
  if (!probe) {
    probe = (async () => {
      try {
        await db.settings.put({ key: '__blob_probe', value: sample.slice(0, 1) })
        await db.settings.delete('__blob_probe')
        return true
      } catch {
        return false
      }
    })()
    blobSupport.set(db, probe)
  }
  return probe
}
async function encodeBinary(db: CaptureDb, blob: Blob): Promise<StoredBinary> {
  if (await blobStorageSupported(db, blob)) return blob
  return { kind: 'bytes', bytes: await readBlob(blob), type: blob.type }
}
function decodeBinary(value: StoredBinary): Blob {
  // Tagged, not duck-typed: Blob itself has a bytes() method in current browsers and Node.
  const tagged = value as Partial<StoredBytes>
  return tagged.kind === 'bytes' ? new Blob([tagged.bytes!], { type: tagged.type ?? '' }) : (value as Blob)
}
function decodePhotoBlob(row: StoredPhotoBlob | undefined): PhotoBlob | undefined {
  if (!row) return undefined
  return {
    photo_id: row.photo_id,
    original: decodeBinary(row.original),
    thumbnail: row.thumbnail ? decodeBinary(row.thumbnail) : null,
  }
}
/** Read a photo's stored bytes as Blobs, whatever storage form the browser required. */
export async function readPhotoBlob(id: Id, databaseName = 'kufang-capture'): Promise<PhotoBlob | undefined> {
  const db = getCaptureDb(databaseName)
  return decodePhotoBlob((await db.photoBlobs.get(id)) as StoredPhotoBlob | undefined)
}

export async function hasLocalBlob(id: Id, databaseName = 'kufang-capture'): Promise<boolean> {
  return (await getCaptureDb(databaseName).photoBlobs.get(id)) !== undefined
}

export function createRepo(options: RepoOptions = {}): Repo {
  const db = getCaptureDb(options.databaseName)
  if (options.binaryStorage === 'bytes') blobSupport.set(db, Promise.resolve(false))
  const imageProcessor = options.imageProcessor ?? defaultImageProcessor
  const now = options.now ?? (() => new Date())
  const stamp = () => now().toISOString()
  configurePhotoBlobLoader(async (id) => decodePhotoBlob(await db.photoBlobs.get(id)))

  const enqueue = async (
    collection: Collection,
    entity: OutboxEntity,
    record: Collection | Item | Entry | Photo,
    op: OutboxOp,
    fields: Record<string, unknown>,
  ) => {
    if (collection.storage_mode !== 'synced') return
    const matches = await db.outbox.where('[entity+entity_id]').equals([entity, record.id]).toArray()
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
  const MISSING_ITEM = {
    title: '',
    notes: '',
    expiration_date: null,
    dimensions: '',
    review_status: 'draft',
  } as const satisfies Pick<Item, 'title' | 'notes' | 'expiration_date' | 'dimensions' | 'review_status'>
  /** Batched read model: one items, one placements and one collections query for any number of entries. */
  const entryViews = async (entries: Entry[]): Promise<EntryView[]> => {
    if (!entries.length) return []
    const itemIds = [...new Set(entries.map((entry) => entry.item_id))]
    const [items, placements, collections] = await Promise.all([
      db.items.bulkGet(itemIds),
      db.entries.where('item_id').anyOf(itemIds).toArray(),
      db.collections.toArray(),
    ])
    const itemById = new Map(items.filter((item) => item !== undefined).map((item) => [item.id, item]))
    const names = new Map(collections.map((collection) => [collection.id, collection.name]))
    const placementsByItem = new Map<Id, Entry[]>()
    for (const placement of placements) {
      const list = placementsByItem.get(placement.item_id) ?? []
      list.push(placement)
      placementsByItem.set(placement.item_id, list)
    }
    return entries.map((entry) => {
      // A pulled entry can arrive a page before its item; show blank shared fields until it lands.
      const item = itemById.get(entry.item_id) ?? MISSING_ITEM
      return {
        ...entry,
        title: item.title,
        notes: item.notes,
        expiration_date: item.expiration_date,
        dimensions: item.dimensions,
        review_status: item.review_status,
        shared_with: (placementsByItem.get(entry.item_id) ?? [])
          .filter((placement) => placement.id !== entry.id && placement.deleted_at === null)
          .map((placement) => ({
            collection_id: placement.collection_id,
            collection_name: names.get(placement.collection_id) ?? '',
            entry_id: placement.id,
            sequence_number: placement.sequence_number,
          })),
      }
    })
  }
  const entryView = async (entry: Entry): Promise<EntryView> => (await entryViews([entry]))[0]!
  const itemContext = async (itemId: Id) => {
    const entry = await db.entries.where('item_id').equals(itemId).first()
    const collection = entry ? await db.collections.get(entry.collection_id) : undefined
    return { entry, collection }
  }
  const activePhotos = async (entryId: Id) => {
    const entry = await db.entries.get(entryId)
    if (!entry) return []
    return db.photos
      .where('item_id')
      .equals(entry.item_id)
      .toArray()
      .then((rows) =>
        rows.filter((photo) => photo.deleted_at === null).sort((a, b) => a.sort_order - b.sort_order),
      )
  }
  const validateCover = async (entryId: Id, collection: Collection) => {
    const entry = await db.entries.get(entryId)
    const rows = entry ? await db.photos.where('item_id').equals(entry.item_id).toArray() : []
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
    const [entries, allPhotos, allOutbox, items] = await Promise.all([
      db.entries.where('collection_id').equals(collection.id).toArray(),
      db.photos.toArray(),
      db.outbox.toArray(),
      db.items.toArray(),
    ])
    const itemIds = new Set(entries.map((entry) => entry.item_id))
    const photos = allPhotos.filter((photo) => itemIds.has(photo.item_id))
    const photoIds = new Set(photos.map((photo) => photo.id))
    const outbox = allOutbox.filter(
      (item) =>
        item.collection_id === collection.id ||
        (item.entity === 'item' && itemIds.has(item.entity_id)) ||
        (item.entity === 'photo' && photoIds.has(item.entity_id)),
    )
    const itemById = new Map(items.map((item) => [item.id, item]))
    const activeEntries = entries.filter((entry) => entry.deleted_at === null)
    const activePhotos = photos.filter(
      (photo) =>
        photo.deleted_at === null &&
        entries.some((entry) => entry.item_id === photo.item_id && entry.deleted_at === null),
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
    const photoByItem = new Map<Id, number>()
    for (const photo of activePhotos)
      photoByItem.set(photo.item_id, (photoByItem.get(photo.item_id) ?? 0) + 1)
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
        isIncomplete(
          { ...entry, review_status: itemById.get(entry.item_id)?.review_status ?? 'draft' },
          (photoByItem.get(entry.item_id) ?? 0) > 0,
        ),
      ).length,
      needs_review_count: activeEntries.filter(
        (entry) => itemById.get(entry.item_id)?.review_status === 'needs_review',
      ).length,
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
      const entries = await db.entries.where('collection_id').equals(id).toArray()
      const itemIds = [...new Set(entries.map((entry) => entry.item_id))]
      const photos = await db.photos.where('item_id').anyOf(itemIds).toArray()
      const allEntries = await db.entries.toArray()
      const sharedItems = new Set(
        entries
          .filter(
            (entry) =>
              entry.deleted_at === null &&
              allEntries.some(
                (other) =>
                  other.collection_id !== id && other.item_id === entry.item_id && other.deleted_at === null,
              ),
          )
          .map((entry) => entry.item_id),
      ).size
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
        shared_items: sharedItems,
      }
    },
    clearCollection: async (id, confirmName) => {
      await db.transaction(
        'rw',
        [db.collections, db.items, db.entries, db.photos, db.photoBlobs, db.outbox],
        async () => {
          const collection = await db.collections.get(id)
          if (!collection) throw new Error('Collection not found')
          if (confirmName !== collection.name) throw new Error('Collection name confirmation did not match.')
          const entries = await db.entries.where('collection_id').equals(id).toArray()
          const itemIds = [...new Set(entries.map((entry) => entry.item_id))]
          const photos = await db.photos.where('item_id').anyOf(itemIds).toArray()
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
          const allEntries = await db.entries.toArray()
          const entryIds = entries.map((entry) => entry.id)
          await db.entries.bulkDelete(entryIds)
          for (const itemId of itemIds) {
            if (allEntries.some((entry) => !entryIds.includes(entry.id) && entry.item_id === itemId)) {
              const kept = allEntries.find(
                (entry) => !entryIds.includes(entry.id) && entry.item_id === itemId,
              )!
              const queued = await db.outbox
                .where('[entity+entity_id]')
                .anyOf([
                  ['item', itemId],
                  ...photos.filter((p) => p.item_id === itemId).map((p) => ['photo', p.id]),
                ])
                .toArray()
              for (const mutation of queued)
                if (mutation.collection_id === id)
                  await db.outbox.put({ ...mutation, collection_id: kept.collection_id })
              continue
            }
            const removePhotos = photos.filter((photo) => photo.item_id === itemId).map((photo) => photo.id)
            await db.photoBlobs.bulkDelete(removePhotos)
            await db.photos.bulkDelete(removePhotos)
            await db.items.delete(itemId)
            await db.outbox
              .where('[entity+entity_id]')
              .anyOf([['item', itemId], ...removePhotos.map((photoId) => ['photo', photoId])])
              .delete()
          }
          await db.outbox.where('collection_id').equals(id).delete()
          await db.collections.delete(id)
        },
      )
    },
    watchEntryRows: (collectionId, query) =>
      liveQuery(async () => {
        const entries = await db.entries.where('collection_id').equals(collectionId).toArray()
        const relevant = new Set(entries.map((entry) => entry.item_id))
        const [photos, outbox] = await Promise.all([
          db.photos
            .where('item_id')
            .anyOf([...relevant])
            .toArray(),
          db.outbox.toArray(),
        ])
        const photoIds = new Set(photos.map((photo) => photo.id))
        const relevantOutbox = outbox.filter(
          (item) =>
            item.collection_id === collectionId ||
            (item.entity === 'item' && relevant.has(item.entity_id)) ||
            (item.entity === 'photo' && photoIds.has(item.entity_id)),
        )
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
        const views = await entryViews(sortedEntries)
        const rows: EntryRow[] = views
          .map((entry) => {
            const entryPhotos = activePhotos.filter((photo) => photo.item_id === entry.item_id)
            const allEntryPhotos = photos.filter((photo) => photo.item_id === entry.item_id)
            const incomplete = isIncomplete(entry, entryPhotos.length > 0)
            const photoPending = allEntryPhotos.some((photo) =>
              ['pending', 'uploading', 'error'].includes(photo.upload_state),
            )
            const photoIds = new Set(allEntryPhotos.map((photo) => photo.id))
            const queued = relevantOutbox.some(
              (item) =>
                (item.entity === 'entry' && item.entity_id === entry.id) ||
                (item.entity === 'item' && item.entity_id === entry.item_id) ||
                photoIds.has(item.entity_id),
            )
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
    watchEntry: (id) =>
      liveQuery(async () => {
        const entry = await db.entries.get(id)
        return entry ? entryView(entry) : undefined
      }) as Watchable<EntryView | undefined>,
    getEntry: async (id) => {
      const entry = await db.entries.get(id)
      return entry ? entryView(entry) : undefined
    },
    createEntry: async (collectionId, init = {}) =>
      db.transaction('rw', db.collections, db.items, db.entries, db.outbox, db.settings, async () => {
        const collection = await db.collections.get(collectionId)
        if (!collection) throw new Error('Collection not found')
        const at = stamp()
        const unit = init.unit ?? (await repo.getSetting(SETTING_KEYS.lastUnit, ''))
        const id = createId()
        const item: Item = {
          id,
          title: init.title ?? '',
          notes: init.notes ?? '',
          expiration_date: init.expiration_date ?? null,
          dimensions: init.dimensions ?? '',
          review_status: init.review_status ?? 'draft',
          created_at: at,
          updated_at: at,
          revision: 1,
          server_revision: null,
          sync_state: collection.storage_mode === 'local_only' ? 'local_only' : 'pending',
        }
        const entry: Entry = {
          id,
          collection_id: collectionId,
          item_id: id,
          sequence_number: collection.next_sequence_number,
          quantity: init.quantity ?? null,
          unit,
          count_detail: init.count_detail ?? '',
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
        await db.items.add(item)
        await db.entries.add(entry)
        await enqueue(updatedCollection, 'item', item, 'upsert', { ...item })
        await enqueue(updatedCollection, 'entry', entry, 'upsert', { ...entry })
        return entryView(entry)
      }),
    updateEntry: async (id, patch) =>
      db.transaction('rw', db.collections, db.items, db.entries, db.outbox, db.settings, async () => {
        const entry = await db.entries.get(id)
        if (!entry) throw new Error('Entry not found')
        const itemPatch = Object.fromEntries(
          ITEM_FIELDS.flatMap((field) => (field in patch ? [[field, patch[field]]] : [])),
        )
        const entryPatch = Object.fromEntries(
          ['quantity', 'unit', 'count_detail'].flatMap((field) =>
            field in patch ? [[field, patch[field as keyof typeof patch]]] : [],
          ),
        )
        if (Object.keys(itemPatch).length) {
          const item = await db.items.get(entry.item_id)
          const collection = await db.collections.get(entry.collection_id)
          if (!item || !collection) throw new Error('Item not found')
          const updated: Item = {
            ...item,
            ...itemPatch,
            updated_at: stamp(),
            revision: item.revision + 1,
            sync_state: collection.storage_mode === 'local_only' ? 'local_only' : 'pending',
          }
          await db.items.put(updated)
          await touchCollection(collection, updated.updated_at)
          await enqueue(collection, 'item', updated, 'upsert', itemPatch)
        }
        if (Object.keys(entryPatch).length) await saveEntry({ ...entry, ...entryPatch }, entryPatch)
        if (typeof patch.unit === 'string' && patch.unit.trim())
          await db.settings.put({ key: SETTING_KEYS.lastUnit, value: patch.unit })
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
    checkStorageMode: async (id, mode) => {
      const collection = await db.collections.get(id)
      if (!collection) throw new Error('Collection not found')
      if (collection.storage_mode === mode) return { allowed: true, blockers: [] }
      const ownEntries = await db.entries.where('collection_id').equals(id).toArray()
      const ownItems = new Set(ownEntries.map((entry) => entry.item_id))
      const others = await db.entries.toArray()
      const collections = new Map((await db.collections.toArray()).map((row) => [row.id, row]))
      const counts = new Map<Id, Set<Id>>()
      for (const entry of others) {
        if (!ownItems.has(entry.item_id) || entry.collection_id === id) continue
        const other = collections.get(entry.collection_id)
        if (!other || other.storage_mode === mode) continue
        const set = counts.get(other.id) ?? new Set<Id>()
        set.add(entry.item_id)
        counts.set(other.id, set)
      }
      const blockers = [...counts].map(([collection_id, itemIds]) => ({
        collection_id,
        collection_name: collections.get(collection_id)?.name ?? '',
        storage_mode: collections.get(collection_id)!.storage_mode,
        shared_items: itemIds.size,
      }))
      return { allowed: blockers.length === 0, blockers }
    },
    watchImportSources: (targetId) =>
      liveQuery(async () => {
        const target = await db.collections.get(targetId)
        if (!target) return []
        return (await db.collections.toArray()).filter(
          (row) => row.id !== targetId && row.storage_mode === target.storage_mode,
        )
      }) as Watchable<Collection[]>,
    watchImportCandidates: (targetId, sourceId, search) =>
      liveQuery(async () => {
        const [target, entries] = await Promise.all([
          db.collections.get(targetId),
          db.entries.where('collection_id').equals(sourceId).toArray(),
        ])
        if (!target) return []
        const term = search.trim().toLocaleLowerCase()
        const active = entries
          .filter((entry) => entry.deleted_at === null)
          .sort((a, b) => b.sequence_number - a.sequence_number)
        const [targetEntries, photos, views] = await Promise.all([
          db.entries.where('collection_id').equals(targetId).toArray(),
          db.photos
            .where('item_id')
            .anyOf([...new Set(active.map((entry) => entry.item_id))])
            .toArray(),
          entryViews(active),
        ])
        return Promise.all(
          views.map(async (item) => {
            const entry = item
            const related = photos
              .filter((photo) => photo.item_id === entry.item_id && photo.deleted_at === null)
              .sort((a, b) => b.captured_at.localeCompare(a.captured_at) || b.id.localeCompare(a.id))
            const already_here = targetEntries.some(
              (other) => other.item_id === entry.item_id && other.deleted_at === null,
            )
            const row = {
              entry: item,
              photo_count: related.length,
              recent_photos: related.slice(0, 3),
              is_incomplete: isIncomplete(item, related.length > 0),
              pending_sync: false,
              already_here,
            }
            return row
          }),
        ).then((rows) =>
          rows.filter(
            (row) =>
              !term ||
              [
                String(row.entry.sequence_number),
                formatSequence(row.entry.sequence_number),
                row.entry.title,
                row.entry.notes,
                row.entry.count_detail,
                row.entry.unit,
              ].some((value) => value.toLocaleLowerCase().includes(term)),
          ),
        )
      }) as Watchable<import('../repo').ImportCandidate[]>,
    importEntries: async (targetId, sourceIds) =>
      db.transaction('rw', db.collections, db.entries, db.items, db.outbox, db.settings, async () => {
        const target = await db.collections.get(targetId)
        if (!target) throw new Error('Collection not found')
        const sources = await Promise.all(sourceIds.map((sourceId) => db.entries.get(sourceId)))
        const created: EntryView[] = []
        const restored: EntryView[] = []
        const skipped: Id[] = []
        for (const source of sources) {
          if (!source) continue
          const sourceCollection = await db.collections.get(source.collection_id)
          if (!sourceCollection || sourceCollection.storage_mode !== target.storage_mode)
            throw new Error('Collections must use the same storage mode to share items.')
          const current = await db.entries
            .where('[collection_id+item_id]')
            .equals([targetId, source.item_id])
            .toArray()
          if (current.some((row) => row.deleted_at === null)) {
            skipped.push(source.id)
            continue
          }
          const deleted = current.find((row) => row.deleted_at !== null)
          if (deleted) {
            const saved = {
              ...deleted,
              deleted_at: null,
              updated_at: stamp(),
              revision: deleted.revision + 1,
              sync_state:
                target.storage_mode === 'local_only' ? ('local_only' as const) : ('pending' as const),
            }
            await db.entries.put(saved)
            await enqueue(target, 'entry', saved, 'restore', { deleted_at: null })
            restored.push(await entryView(saved))
          } else {
            const at = stamp()
            const entry: Entry = {
              id: createId(),
              collection_id: targetId,
              item_id: source.item_id,
              sequence_number: target.next_sequence_number++,
              quantity: null,
              unit: source.unit,
              count_detail: '',
              deleted_at: null,
              created_at: at,
              updated_at: at,
              revision: 1,
              server_revision: null,
              sync_state: target.storage_mode === 'local_only' ? 'local_only' : 'pending',
            }
            await db.entries.add(entry)
            await enqueue(target, 'entry', entry, 'upsert', { ...entry })
            created.push(await entryView(entry))
          }
          await db.collections.put({
            ...target,
            updated_at: stamp(),
            revision: target.revision + 1,
            sync_state: target.storage_mode === 'local_only' ? 'local_only' : 'pending',
          })
        }
        return { created, restored, skipped }
      }),
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
          stored: await encodeBinary(db, photo.blob),
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
            const { digest, checksum, stored } = prepared[index]!
            const mime = photo.blob.type || mimeFromFilename(photo.filename)
            const filename = photo.filename || generatedFilename(capturedAt, mime)
            const item: Photo = {
              id: createId(),
              item_id: entry.item_id,
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
            await db.photoBlobs.add({ photo_id: item.id, original: stored, thumbnail: null })
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
          const storedThumbnail = await encodeBinary(db, processed.thumbnail)
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
            await db.photoBlobs.put({ ...blob, thumbnail: storedThumbnail })
            await enqueue(currentCollection, 'photo', saved, 'upsert', {
              width: saved.width,
              height: saved.height,
            })
          })
          // The preview cache may hold the full original as a stand-in; switch to the thumbnail.
          invalidateThumbnail(item.id)
        } catch {
          /* Original and metadata were already durably committed; thumbnail can be retried later. */
        }
      }
      return created
    },
    watchPhotos: (entryId, opts = {}) =>
      liveQuery(async () => {
        const entry = await db.entries.get(entryId)
        if (!entry) return []
        const rows = await db.photos.where('item_id').equals(entry.item_id).toArray()
        return rows
          .filter((photo) => opts.includeDeleted || photo.deleted_at === null)
          .sort((a, b) => a.sort_order - b.sort_order)
      }) as Watchable<Photo[]>,
    updatePhoto: async (id, patch) =>
      db.transaction('rw', db.photos, db.entries, db.collections, db.outbox, async () => {
        const photo = await db.photos.get(id)
        if (!photo) throw new Error('Photo not found')
        const { collection } = await itemContext(photo.item_id)
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
      db.transaction('rw', db.photos, db.entries, db.collections, db.outbox, async () => {
        const photo = await db.photos.get(id)
        if (!photo || photo.deleted_at) throw new Error('Photo not found')
        const { collection } = await itemContext(photo.item_id)
        if (!collection) throw new Error('Collection not found')
        const rows = await db.photos.where('item_id').equals(photo.item_id).toArray()
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
        const rows = await db.photos.where('item_id').equals(entry.item_id).toArray()
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
      db.transaction('rw', db.photos, db.entries, db.collections, db.outbox, async () => {
        const photo = await db.photos.get(id)
        if (!photo) return
        const { collection } = await itemContext(photo.item_id)
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
        const contextEntry = await db.entries.where('item_id').equals(photo.item_id).first()
        if (contextEntry) await validateCover(contextEntry.id, collection)
      }),
    restorePhoto: async (id) =>
      db.transaction('rw', db.photos, db.entries, db.collections, db.outbox, async () => {
        const photo = await db.photos.get(id)
        if (!photo) return
        const { collection } = await itemContext(photo.item_id)
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
        const contextEntry = await db.entries.where('item_id').equals(photo.item_id).first()
        if (contextEntry) await validateCover(contextEntry.id, collection)
      }),
    getPhotoBlob: async (id) => decodePhotoBlob(await db.photoBlobs.get(id)),
    watchDeletedPhotos: (collectionId) =>
      liveQuery(async () => {
        const [photos, entries] = await Promise.all([
          db.photos.toArray(),
          db.entries.where('collection_id').equals(collectionId).toArray(),
        ])
        const activeItems = new Set(
          entries.filter((entry) => entry.deleted_at === null).map((entry) => entry.item_id),
        )
        return photos
          .filter((photo) => photo.deleted_at !== null && activeItems.has(photo.item_id))
          .sort((a, b) => b.updated_at.localeCompare(a.updated_at))
      }) as Watchable<Photo[]>,
    getSetting: async <T>(key: string, fallback: T): Promise<T> =>
      ((await db.settings.get(key))?.value as T) ?? fallback,
    setStorageMode: async (id, mode: StorageMode, opts) =>
      db.transaction('rw', db.collections, db.entries, db.items, db.photos, db.outbox, async () => {
        const collection = await db.collections.get(id)
        if (!collection) throw new Error('Collection not found')
        if (collection.storage_mode === mode) return
        const at = stamp()
        if (mode === 'synced' && !opts.consentToUploadExisting)
          throw new Error('Consent is required before uploading existing data.')
        const modeCheck = await repo.checkStorageMode(id, mode)
        if (!modeCheck.allowed)
          throw new Error(
            'Storage mode cannot change while items are shared with collections in another mode.',
          )
        const entries = await db.entries.where('collection_id').equals(id).toArray()
        const itemIds = [...new Set(entries.map((entry) => entry.item_id))]
        const photos = await db.photos.where('item_id').anyOf(itemIds).toArray()
        if (mode === 'local_only') {
          const associated = await db.outbox.toArray()
          await db.outbox.bulkDelete(
            associated
              .filter(
                (item) =>
                  item.collection_id === id ||
                  (item.entity === 'item' && itemIds.includes(item.entity_id)) ||
                  (item.entity === 'photo' && photos.some((photo) => photo.id === item.entity_id)),
              )
              .map((item) => item.id),
          )
          await db.photos.bulkPut(
            photos.map((photo) => ({
              ...photo,
              upload_state: photo.upload_state === 'uploaded' ? 'uploaded' : 'not_needed',
              upload_next_attempt_at: null,
              sync_state: 'local_only' as const,
            })),
          )
          await db.entries.bulkPut(entries.map((entry) => ({ ...entry, sync_state: 'local_only' })))
          const localItems = await db.items.bulkGet(itemIds)
          await db.items.bulkPut(
            localItems
              .filter((item): item is Item => !!item)
              .map((item) => ({ ...item, sync_state: 'local_only' })),
          )
          await db.collections.put({
            ...collection,
            storage_mode: mode,
            updated_at: at,
            sync_state: 'local_only',
          })
          return
        }
        const synced = {
          ...collection,
          storage_mode: mode,
          sync_consented_at: at,
          updated_at: at,
          sync_state: 'pending' as const,
        }
        await db.collections.put(synced)
        await enqueue(synced, 'collection', synced, 'upsert', { ...synced })
        for (const entry of entries) {
          const pending = { ...entry, sync_state: 'pending' as const }
          await db.entries.put(pending)
          await enqueue(synced, 'entry', pending, 'upsert', { ...pending })
        }
        for (const itemId of itemIds) {
          const item = await db.items.get(itemId)
          if (!item) continue
          const pending = { ...item, sync_state: 'pending' as const }
          await db.items.put(pending)
          await enqueue(synced, 'item', pending, 'upsert', { ...pending })
        }
        for (const photo of photos) {
          const pending = {
            ...photo,
            sync_state: 'pending' as const,
            upload_state: photo.deleted_at === null ? ('pending' as const) : photo.upload_state,
            upload_attempts: 0,
            upload_next_attempt_at: null,
          }
          await db.photos.put(pending)
          await enqueue(synced, 'photo', pending, 'upsert', { ...pending })
        }
      }),
    readForExport: async (collectionIds) =>
      db.transaction('r', db.collections, db.entries, db.items, db.photos, async () => {
        const collections =
          collectionIds === 'all'
            ? await db.collections.toArray()
            : (await db.collections.bulkGet(collectionIds)).filter((c): c is Collection => !!c)
        const ids = collections.map((c) => c.id)
        const entries = await db.entries.where('collection_id').anyOf(ids).toArray()
        const itemIds = [...new Set(entries.map((entry) => entry.item_id))]
        const [items, photos] = await Promise.all([
          db.items.bulkGet(itemIds).then((rows) => rows.filter((item): item is Item => !!item)),
          db.photos.where('item_id').anyOf(itemIds).toArray(),
        ])
        return { collections, entries, items, photos }
      }),
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
