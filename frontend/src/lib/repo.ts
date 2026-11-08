// Local repository contract. The UI reads and writes ONLY through this
// interface; every write commits a durable IndexedDB transaction before its
// promise resolves. Implemented by src/lib/db (Dexie). Owned by the orchestrator.

import type {
  CaptureSource,
  Collection,
  CollectionSummary,
  Entry,
  EntryRow,
  Id,
  Photo,
  PhotoBlob,
  StorageMode,
} from './types'

/** Svelte-store-compatible observable (Dexie liveQuery satisfies this). */
export interface Watchable<T> {
  subscribe(next: (value: T) => void, error?: (err: unknown) => void): (() => void) | { unsubscribe(): void }
}

export type EntryFilter = 'all' | 'incomplete' | 'pending_sync' | 'deleted'
export type EntrySort = 'newest' | 'oldest'

export interface EntryQuery {
  /** Matches sequence number ("42", "#0042"), title, notes, count_detail, unit; case-insensitive. */
  search: string
  filter: EntryFilter
  sort: EntrySort
}

export type EntryPatch = Partial<
  Pick<
    Entry,
    | 'title'
    | 'quantity'
    | 'unit'
    | 'count_detail'
    | 'notes'
    | 'expiration_date'
    | 'dimensions'
    | 'review_status'
  >
>

export interface NewCollectionInput {
  name: string
  description?: string
  storage_mode: StorageMode
}

export interface IncomingPhoto {
  /** Exact bytes from the capture route. Stored unmodified. */
  blob: Blob
  /** Original filename if the route provided one; otherwise generated. */
  filename?: string
  source: CaptureSource
  /** Defaults to now. For library imports, File.lastModified may be used. */
  captured_at?: string
}

export interface ClearCheck {
  allowed: boolean
  /** Human-readable reasons when not allowed, e.g. "3 photos not exported since last change". */
  reasons: string[]
  unexported_changes: boolean
  pending_uploads: number
  last_exported_at: string | null
}

export interface StorageEstimate {
  usage: number | null
  quota: number | null
  persisted: boolean | null
}

export interface Repo {
  // Collections
  watchCollectionSummaries(opts: { includeArchived: boolean }): Watchable<CollectionSummary[]>
  watchCollectionSummary(id: Id): Watchable<CollectionSummary | undefined>
  getCollection(id: Id): Promise<Collection | undefined>
  createCollection(input: NewCollectionInput): Promise<Collection>
  updateCollection(
    id: Id,
    patch: Partial<Pick<Collection, 'name' | 'description' | 'sort_order'>>,
  ): Promise<void>
  archiveCollection(id: Id): Promise<void>
  unarchiveCollection(id: Id): Promise<void>
  /** Record a completed export that covered these collections. */
  markExported(collectionIds: Id[], at?: string): Promise<void>
  /** Whether a guarded, irreversible clear is currently safe. */
  checkClearCollection(id: Id): Promise<ClearCheck>
  /**
   * Irreversibly delete a collection and all its entries/photos/blobs from this
   * device. Rejects unless checkClearCollection allows it AND confirmName
   * exactly equals the collection name.
   */
  clearCollection(id: Id, confirmName: string): Promise<void>

  // Entries
  watchEntryRows(collectionId: Id, query: EntryQuery): Watchable<EntryRow[]>
  watchEntry(id: Id): Watchable<Entry | undefined>
  getEntry(id: Id): Promise<Entry | undefined>
  /**
   * Allocate the next sequence number and create the entry in ONE transaction.
   * unit defaults to the last used unit. Resolves only after the commit.
   */
  createEntry(collectionId: Id, init?: EntryPatch): Promise<Entry>
  updateEntry(id: Id, patch: EntryPatch): Promise<void>
  /** Soft delete (sets deleted_at). Photos stay linked and come back on restore. */
  deleteEntry(id: Id): Promise<void>
  restoreEntry(id: Id): Promise<void>
  /** Neighbours in the given sort order among non-deleted entries. */
  getAdjacentEntryIds(entryId: Id, sort: EntrySort): Promise<{ prev: Id | null; next: Id | null }>

  // Photos
  /**
   * Persist originals (and derived metadata/thumbnails) for an entry. Resolves
   * after every original Blob is committed; thumbnail generation failure must
   * not lose the original.
   */
  addPhotos(entryId: Id, photos: IncomingPhoto[]): Promise<Photo[]>
  watchPhotos(entryId: Id, opts?: { includeDeleted?: boolean }): Watchable<Photo[]>
  updatePhoto(id: Id, patch: Partial<Pick<Photo, 'caption'>>): Promise<void>
  /** Exactly one cover per entry. */
  setCoverPhoto(id: Id): Promise<void>
  reorderPhotos(entryId: Id, orderedIds: Id[]): Promise<void>
  deletePhoto(id: Id): Promise<void>
  restorePhoto(id: Id): Promise<void>
  getPhotoBlob(id: Id): Promise<PhotoBlob | undefined>
  /** Deleted photos whose entries are NOT deleted (entry-level trash shows its own photos). */
  watchDeletedPhotos(collectionId: Id): Watchable<Photo[]>

  // Export
  /**
   * Snapshot of the given collections (or all) with ALL their entries and photos, including
   * soft-deleted ones (the exporter decides active vs trash), read in one transaction.
   */
  readForExport(collectionIds: Id[] | 'all'): Promise<{
    collections: Collection[]
    entries: Entry[]
    photos: Photo[]
  }>

  // Settings and storage
  getSetting<T>(key: string, fallback: T): Promise<T>
  setSetting(key: string, value: unknown): Promise<void>
  estimateStorage(): Promise<StorageEstimate>
  requestPersistentStorage(): Promise<boolean>
}
