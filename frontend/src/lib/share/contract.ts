// Read-only share links. Orchestrator-owned contract mirroring docs/api.md (Read-only share links).
import type { Id, ReviewStatus, Timestamp } from '$lib/types'

/** Allowed `expires_in_days` choices offered by the share sheet; `null` means no expiry. */
export const SHARE_EXPIRY_CHOICES = [7, 30, 90, null] as const
export type ShareExpiryChoice = (typeof SHARE_EXPIRY_CHOICES)[number]
export const DEFAULT_SHARE_EXPIRY_DAYS = 30

/** Request header that carries the share token on every `/api/share` request. */
export const SHARE_HEADER = 'X-Capture-Share'
/** 32 random bytes, base64url without padding. */
export const SHARE_TOKEN_RE = /^[A-Za-z0-9_-]{43}$/

/** A link as listed in the owner's share sheet (`GET /api/shares`). */
export interface ShareLink {
  id: Id
  collection_id: Id
  collection_name: string
  label: string | null
  url: string
  created_at: Timestamp
  expires_at: Timestamp | null
  last_viewed_at: Timestamp | null
  expired: boolean
}

export interface CreateShareRequest {
  collection_id: Id
  label?: string | null
  expires_in_days?: number | null
}

export interface SharedPhoto {
  id: Id
  mime_type: string
  byte_size: number
  width: number | null
  height: number | null
  captured_at: Timestamp
  caption: string
  is_cover: boolean
  sort_order: number
  /** True once the original has been uploaded and verified on the server. */
  stored: boolean
}

export interface SharedEntry {
  id: Id
  item_id: Id
  sequence_number: number
  quantity: string | null
  unit: string
  count_detail: string
  entry_notes: string
  title: string
  notes: string
  expiration_date: string | null
  dimensions: string
  review_status: ReviewStatus
  created_at: Timestamp
  updated_at: Timestamp
  photos: SharedPhoto[]
}

/** `GET /api/share` response. */
export interface SharedCollection {
  schema: 1
  share: { label: string | null; expires_at: Timestamp | null }
  collection: {
    id: Id
    name: string
    description: string
    folder: string
    status: 'active' | 'archived'
    archived_at: Timestamp | null
  }
  updated_at: Timestamp
  entries: SharedEntry[]
}

/** Parsed `/share` fragment: `#<token>` or `#<token>/e/<sequence_number>`. */
export interface ShareLocation {
  token: string
  sequence: number | null
}
