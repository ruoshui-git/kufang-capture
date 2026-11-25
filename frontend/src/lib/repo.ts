// Local repository contract. The UI reads and writes ONLY through this
// interface; every write commits a durable IndexedDB transaction before its
// promise resolves. Implemented by src/lib/db (Dexie). Owned by the orchestrator.

import type {
  CaptureSource,
  Collection,
  CollectionSummary,
  Entry,
  EntryRow,
  EntryView,
  Id,
  Item,
  Photo,
  PhotoBlob,
  StarredRow,
  StorageMode,
  Entry as EntryRecord,
} from './types'

/** Svelte-store-compatible observable (Dexie liveQuery satisfies this). */
export interface Watchable<T> {
  subscribe(next: (value: T) => void, error?: (err: unknown) => void): (() => void) | { unsubscribe(): void }
}

/**
 * - incomplete: missing photos or quantity, or review_status 'needs_review' (isIncomplete).
 * - missing_quantity: quantity null. missing_title: title blank after trim. missing_photos: no active photo.
 * - needs_review: review_status 'needs_review'. starred: starred_at set.
 * All filters except 'deleted' list non-deleted entries only.
 */
export type EntryFilter =
  | 'all'
  | 'incomplete'
  | 'missing_quantity'
  | 'missing_title'
  | 'missing_photos'
  | 'needs_review'
  | 'starred'
  | 'pending_sync'
  | 'deleted'
/** newest/oldest: by sequence_number. last_edited: EntryRow.last_edited_at desc, ties by sequence_number desc. */
export type EntrySort = 'newest' | 'oldest' | 'last_edited'

export interface EntryQuery {
  /**
   * Matches sequence number ("42", "#0042"), title, notes, entry_notes, count_detail, unit;
   * case-insensitive.
   */
  search: string
  filter: EntryFilter
  sort: EntrySort
}

/**
 * Fields the UI edits on an entry. The repository splits a patch: ITEM_FIELDS go to
 * the shared Item (visible in every collection that has it), ENTRY_COUNT_FIELDS stay
 * on this collection's Entry.
 */
export type EntryPatch = Partial<
  Pick<
    EntryView,
    | 'title'
    | 'quantity'
    | 'unit'
    | 'count_detail'
    | 'entry_notes'
    | 'notes'
    | 'expiration_date'
    | 'dimensions'
    | 'review_status'
  >
>

export interface NewCollectionInput {
  name: string
  description?: string
  /** Defaults to ''. Trimmed. */
  folder?: string
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
  /** Active items of this collection that other collections also have; clearing keeps them there. */
  shared_items: number
}

/** A collection whose shared items block a storage-mode switch. */
export interface SharedModeBlocker {
  collection_id: Id
  collection_name: string
  storage_mode: StorageMode
  /** Items this collection shares with the blocker. */
  shared_items: number
}

export interface StorageModeCheck {
  allowed: boolean
  /** Collections in the OTHER mode sharing items with this one (deleted entries included). */
  blockers: SharedModeBlocker[]
}

export interface ImportCandidate extends EntryRow {
  /** The target collection already has an active entry for this item. */
  already_here: boolean
}

export interface ImportSearchPlacement {
  collection_id: Id
  collection_name: string
  sequence_number: number
  quantity: string | null
  unit: string
  archived: boolean
  last_edited_at: string
}

export interface ImportSearchRow extends EntryRow {
  placements: ImportSearchPlacement[]
  archived: boolean
  already_here: boolean
}

export interface ImportResult {
  /** New entries created in the target, in source order. */
  created: EntryView[]
  /** Deleted target entries for the same item that were restored (keeping their old numbers). */
  restored: EntryView[]
  /** Source entry ids skipped because the target already had the item. */
  skipped: Id[]
}

export interface MoveResult {
  /** Entries newly created in the target, in move order. */
  created: EntryView[]
  /** Deleted target entries for the same item that were restored with the source's counts. */
  restored: EntryView[]
  /** Target entries that already had the item active; the source counts were noted and the item marked needs_review. */
  merged_into_existing: EntryView[]
  undo: MoveUndo
}

export interface MoveUndo {
  entries: EntryRecord[]
  items: Item[]
  collections: Collection[]
  /** Revisions immediately after the move; used to reject stale undo snapshots. */
  moved_revisions: { entries: Record<Id, number>; items: Record<Id, number>; collections: Record<Id, number> }
  created_entry_ids: Id[]
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
    patch: Partial<Pick<Collection, 'name' | 'description' | 'folder' | 'sort_order'>>,
  ): Promise<void>
  archiveCollection(id: Id): Promise<void>
  unarchiveCollection(id: Id): Promise<void>
  /** Record a completed export that covered these collections. */
  markExported(collectionIds: Id[], at?: string): Promise<void>
  /**
   * Switch storage mode. local_only → synced requires consentToUploadExisting and enqueues the
   * whole collection (entries, photos, trash) for upload. synced → local_only stops future
   * uploads and drops pending outbox items; it never touches the server copy.
   */
  setStorageMode(id: Id, mode: StorageMode, opts: { consentToUploadExisting: boolean }): Promise<void>
  /**
   * Whether a storage-mode switch is allowed. It is not while any of the collection's items
   * (including removed entries) is shared with a collection in the other mode; setStorageMode
   * rejects in that case too.
   */
  checkStorageMode(id: Id, mode: StorageMode): Promise<StorageModeCheck>
  /** Whether a guarded, irreversible clear is currently safe. */
  checkClearCollection(id: Id): Promise<ClearCheck>
  /**
   * Irreversibly delete a collection and all its entries from this device. Items (with their
   * photos and blobs) that no other collection references are deleted too; shared items stay. Rejects unless checkClearCollection allows it AND confirmName
   * exactly equals the collection name.
   */
  clearCollection(id: Id, confirmName: string): Promise<void>

  // Entries
  watchEntryRows(collectionId: Id, query: EntryQuery): Watchable<EntryRow[]>
  watchEntry(id: Id): Watchable<EntryView | undefined>
  getEntry(id: Id): Promise<EntryView | undefined>
  /**
   * Allocate the next sequence number and create the entry and its new item (item_id = entry id)
   * in ONE transaction. unit defaults to the last used unit. Resolves only after the commit.
   */
  createEntry(collectionId: Id, init?: EntryPatch): Promise<EntryView>
  /** Splits the patch between the shared item and this entry; one transaction. */
  updateEntry(id: Id, patch: EntryPatch): Promise<void>
  /**
   * Soft delete of this collection's entry only (sets deleted_at). The item, its photos and its
   * entries in other collections are untouched. Restore brings back the same number.
   */
  deleteEntry(id: Id): Promise<void>
  restoreEntry(id: Id): Promise<void>
  /** Neighbours in the given sort order among non-deleted entries. */
  getAdjacentEntryIds(entryId: Id, sort: EntrySort): Promise<{ prev: Id | null; next: Id | null }>
  /**
   * Star (starred_at = now) or unstar (null) this collection's entry only; other entries of the same
   * item are untouched. A no-op when already in the requested state. Queued for sync like any entry field.
   */
  setEntryStarred(entryId: Id, starred: boolean): Promise<void>
  /**
   * Non-deleted starred entries across all collections (archived ones included), most recently
   * starred first.
   */
  watchStarredRows(): Watchable<StarredRow[]>

  // Sharing items between collections
  /** Collections the target may import from: same storage mode, excluding the target. */
  watchImportSources(targetCollectionId: Id): Watchable<Collection[]>
  /** Active entries of the source collection (search as in EntryQuery), marked already_here. */
  watchImportCandidates(
    targetCollectionId: Id,
    sourceCollectionId: Id,
    search: string,
  ): Watchable<ImportCandidate[]>
  /** Search active shared items across same-mode collections, grouped once per item. */
  watchImportSearch(targetCollectionId: Id, query: string): Watchable<ImportSearchRow[]>
  /**
   * In ONE transaction: reject unless both collections exist and share a storage mode; for each
   * source entry, skip it if the target has an active entry for its item, restore the target's
   * deleted entry for the item if there is one, else create a new entry with the next sequence
   * number, the same item_id, the source unit, blank quantity/count_detail/entry_notes, and not starred.
   */
  importEntries(targetCollectionId: Id, sourceEntryIds: Id[]): Promise<ImportResult>
  /** In ONE transaction, move active entries into the target with counts and provenance preserved. */
  moveEntries(targetCollectionId: Id, sourceEntryIds: Id[]): Promise<MoveResult>
  undoMove(undo: MoveUndo): Promise<void>
  /**
   * In ONE transaction, move part of one active entry's count into the target. `quantity` is a raw
   * decimal string with 0 < quantity < the source quantity, in the source's unit; the source stays
   * active with the remainder (exact decimal subtraction). Throws if the source quantity is blank or
   * the amount is out of range. Same target rules and Undo as moveEntries.
   */
  moveEntryPart(targetCollectionId: Id, sourceEntryId: Id, quantity: string): Promise<MoveResult>
  /** Create a collection in the source's storage mode and move entries into it, in ONE transaction. */
  splitEntries(
    sourceEntryIds: Id[],
    input: Omit<NewCollectionInput, 'storage_mode'>,
  ): Promise<{ collection: Collection; result: MoveResult }>
  /** Move every active entry of each source collection, then archive those collections atomically. */
  mergeCollections(targetCollectionId: Id, sourceCollectionIds: Id[]): Promise<MoveResult>

  // Photos (attached to the entry's item, so shared by every collection that has it)
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
  /** Deleted photos of items whose entry in this collection is NOT deleted (entry trash shows its own). */
  watchDeletedPhotos(collectionId: Id): Watchable<Photo[]>

  // Export
  /**
   * Snapshot of the given collections (or all) with ALL their entries, the items those entries
   * reference and those items' photos, including soft-deleted ones (the exporter decides active
   * vs trash), read in one transaction. Each item and photo appears once.
   */
  readForExport(collectionIds: Id[] | 'all'): Promise<{
    collections: Collection[]
    entries: Entry[]
    items: Item[]
    photos: Photo[]
  }>

  // Settings and storage
  getSetting<T>(key: string, fallback: T): Promise<T>
  setSetting(key: string, value: unknown): Promise<void>
  estimateStorage(): Promise<StorageEstimate>
  requestPersistentStorage(): Promise<boolean>
}
