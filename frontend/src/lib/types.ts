// Shared domain contract for Kufang Capture. Owned by the orchestrator; agents
// propose changes instead of editing it. Field names are snake_case so that the
// IndexedDB records, the REST API (docs/api.md) and the export CSV/JSON
// (docs/export-format.md) use one vocabulary.

/** Client-generated ULID (26 chars, Crockford base32). */
export type Id = string
/** ISO 8601 UTC timestamp with milliseconds, e.g. 2026-11-08T07:00:00.000Z. */
export type Timestamp = string

export type StorageMode = 'local_only' | 'synced'
export type CollectionStatus = 'active' | 'archived'
export type ReviewStatus = 'draft' | 'complete' | 'needs_review'
/**
 * Where the original bytes came from.
 * - native_camera: iOS file input with capture=environment (system camera still)
 * - photo_library: file input without capture (Photos / Files)
 * - camera_frame: JPEG encoded by the app from a getUserMedia video frame
 */
export type CaptureSource = 'native_camera' | 'photo_library' | 'camera_frame'

/**
 * Metadata sync state of a record. Local Only collections are always
 * 'local_only' and never enter the outbox.
 */
export type RecordSyncState = 'local_only' | 'pending' | 'synced' | 'conflict' | 'error'
/** Original-file upload state of a photo. */
export type UploadState = 'not_needed' | 'pending' | 'uploading' | 'uploaded' | 'error'

interface Versioned {
  created_at: Timestamp
  updated_at: Timestamp
  /** Local modification counter, incremented on every local write. */
  revision: number
  /** Last server revision acknowledged for this record; null if never synced. */
  server_revision: number | null
  sync_state: RecordSyncState
}

export interface Collection extends Versioned {
  id: Id
  name: string
  description: string
  status: CollectionStatus
  storage_mode: StorageMode
  /** Next number to allocate. Monotonic; never decremented; deleted numbers are never reused. */
  next_sequence_number: number
  sort_order: number | null
  /** When the user consented to upload pre-existing local data; null if never synced. */
  sync_consented_at: Timestamp | null
  /** Last successful export (local ZIP or server export) covering this collection. */
  last_exported_at: Timestamp | null
  archived_at: Timestamp | null
}

/**
 * Shared record behind one or more entries (one per collection). Holds everything
 * that is the same wherever the item appears: photos (Photo.item_id), title,
 * notes, expiration date, dimensions and review status. An item lives while any
 * entry references it. A never-shared entry has item_id === entry.id; existing
 * data migrated from v1 keeps that identity, so ids and photo paths are stable.
 * All collections sharing an item have the same storage_mode.
 */
export interface Item extends Versioned {
  id: Id
  /** Optional custom title; '' means display "Entry #0042". */
  title: string
  notes: string
  /** YYYY-MM-DD or null (null = unknown/unrecorded, not "no expiration"). */
  expiration_date: string | null
  dimensions: string
  review_status: ReviewStatus
}

/** Fields stored on the shared Item. Every other EntryPatch field is per collection. */
export const ITEM_FIELDS = ['title', 'notes', 'expiration_date', 'dimensions', 'review_status'] as const
export type ItemField = (typeof ITEM_FIELDS)[number]
/** Per-collection count fields stored on the Entry. */
export const ENTRY_COUNT_FIELDS = ['quantity', 'unit', 'count_detail'] as const
export type EntryCountField = (typeof ENTRY_COUNT_FIELDS)[number]

/**
 * An item's place in one collection: its number and its count there. Deleting an
 * entry removes the item from this collection only.
 */
export interface Entry extends Versioned {
  id: Id
  collection_id: Id
  item_id: Id
  /** Immutable, allocated from Collection.next_sequence_number. Displayed as #0042. */
  sequence_number: number
  /**
   * Raw decimal string as typed (normalized: trimmed, '.' decimal separator),
   * or null when not recorded. Never a float. Blank is not zero.
   */
  quantity: string | null
  /** Short free text, e.g. "boxes". '' when unspecified. */
  unit: string
  count_detail: string
  /** Removed from this collection (soft delete). */
  deleted_at: Timestamp | null
}

export interface SharedPlacement {
  collection_id: Id
  collection_name: string
  entry_id: Id
  sequence_number: number
}

/**
 * Read model used by the UI: the entry plus its item's shared fields and the
 * OTHER collections that have an active entry for the same item.
 */
export interface EntryView extends Entry, Pick<Item, ItemField> {
  shared_with: SharedPlacement[]
  /**
   * Derived status shown to the user, combining the entry, its item and the item's photos
   * (records, queued outbox rows and uploads). Precedence: conflict, error, pending, synced.
   * A stored 'pending' with nothing queued and a known server_revision reads as 'synced'.
   */
  display_sync_state: RecordSyncState
}

export interface Photo extends Versioned {
  id: Id
  /** Owning item; shared by every collection that has the item. */
  item_id: Id
  sort_order: number
  original_filename: string
  mime_type: string
  byte_size: number
  width: number | null
  height: number | null
  /** Lowercase hex SHA-256 of the original bytes. */
  sha256: string
  /** CRC-32 of the original bytes (unsigned), used for zero-copy ZIP export. */
  crc32: number
  captured_at: Timestamp
  capture_source: CaptureSource
  caption: string
  is_cover: boolean
  deleted_at: Timestamp | null
  upload_state: UploadState
  /** Opaque server key once uploaded and verified. */
  server_storage_key: string | null
}

/** Binary payloads, stored separately so metadata queries stay small. */
export interface PhotoBlob {
  photo_id: Id
  /** Exact bytes received from the capture route. Never modified. */
  original: Blob
  /** Derived JPEG preview (~320px long edge). May be regenerated. */
  thumbnail: Blob | null
}

export type OutboxEntity = 'collection' | 'item' | 'entry' | 'photo'
export type OutboxOp = 'upsert' | 'delete' | 'restore' | 'purge'

/**
 * Durable mutation queued for a synced collection, written in the same
 * IndexedDB transaction as the change itself. Pending items for the same
 * entity are coalesced (fields merged) until the first send attempt starts;
 * once sent, a row's mutation id may already be applied on the server, so later
 * edits go into a new row. At most one row per record is sent at a time. An
 * item is removed only after the server acknowledges it.
 */
export interface OutboxItem {
  /** Mutation ULID; the server treats it as an idempotency key. */
  id: Id
  /**
   * Collection the mutation is attributed to. For item and photo mutations this is
   * a collection with an entry for the item (all share one storage mode).
   */
  collection_id: Id
  entity: OutboxEntity
  entity_id: Id
  op: OutboxOp
  /** server_revision the change was based on (null = create). */
  base_revision: number | null
  /** Changed fields only (full record for create). */
  fields: Record<string, unknown>
  created_at: Timestamp
  attempts: number
  /** Set while a send is in flight; coalescing must not merge into it. */
  in_flight: boolean
  /** Set once a send has started (it may have been applied); coalescing must not merge into it. */
  sent?: boolean
  last_error: string | null
  next_attempt_at: Timestamp | null
}

/** Key/value preferences and device state. */
export interface Setting {
  key: string
  value: unknown
}

export const SETTING_KEYS = {
  lastStorageMode: 'last_storage_mode',
  deviceId: 'device_id',
  syncCursor: 'sync_cursor',
  entrySort: 'entry_sort',
  captureMode: 'capture_mode',
} as const

/** Derived per-collection counts. Entries and quantities are never conflated. */
export interface CollectionSummary {
  collection: Collection
  entry_count: number
  photo_count: number
  /** Entries missing photos or quantity, or with review_status 'needs_review'. */
  incomplete_count: number
  needs_review_count: number
  deleted_entry_count: number
  /** Metadata outbox items + photos whose original is not yet uploaded. */
  pending_sync_count: number
  pending_upload_bytes: number
  /** Quantity subtotals grouped by normalized unit (case-insensitive, trimmed). */
  quantity_by_unit: QuantityByUnit[]
  last_activity_at: Timestamp
}

export interface QuantityByUnit {
  /** Display unit ('' shown as "no unit"). */
  unit: string
  /** Exact decimal string sum, e.g. "12.5". */
  total: string
  entry_count: number
}

/** List-row view model for the inline Entry List. */
export interface EntryRow {
  entry: EntryView
  photo_count: number
  /** Up to 3 non-deleted photos: the cover first, then the most recently captured. */
  recent_photos: Photo[]
  is_incomplete: boolean
  pending_sync: boolean
}

/** Photo order for previews: the cover first, then newest captured (ties broken by id). */
export function byCoverThenNewest(a: Photo, b: Photo): number {
  return (
    Number(b.is_cover) - Number(a.is_cover) ||
    b.captured_at.localeCompare(a.captured_at) ||
    b.id.localeCompare(a.id)
  )
}

export function formatSequence(n: number): string {
  return `#${String(n).padStart(4, '0')}`
}

export function entryDisplayTitle(e: Pick<EntryView, 'title' | 'sequence_number'>): string {
  return e.title.trim() || `Entry ${formatSequence(e.sequence_number)}`
}
