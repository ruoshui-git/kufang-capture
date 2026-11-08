// Sync engine contract (orchestrator-owned). Implemented in src/lib/sync/ by
// wave 3; consumed by the sync/account UI. Server protocol: docs/api.md.

import type { Watchable } from '../repo'
import type { Id, OutboxEntity, Timestamp } from '../types'

export interface CollectionSyncStatus {
  collection_id: Id
  pending_mutations: number
  pending_uploads: number
  pending_upload_bytes: number
  /** Mutations rejected by the server or uploads that failed permanently. */
  errors: number
  conflicts: number
  last_synced_at: Timestamp | null
}

export type SyncPhase = 'idle' | 'syncing' | 'offline' | 'signed_out' | 'error'

export interface SyncStatus {
  phase: SyncPhase
  online: boolean
  /** null while unknown (no session check yet). */
  authenticated: boolean | null
  last_success_at: Timestamp | null
  /** Human-readable last error, e.g. "Couldn't reach the server". */
  last_error: string | null
  /** Totals over synced collections only. */
  pending_mutations: number
  pending_uploads: number
  pending_upload_bytes: number
  conflicts: number
  per_collection: Record<Id, CollectionSyncStatus>
}

/** A server-reported field conflict awaiting the user's choice. */
export interface SyncConflict {
  id: Id
  collection_id: Id
  entity: OutboxEntity
  entity_id: Id
  /** Fields the server reported as conflicting. */
  fields: string[]
  local_values: Record<string, unknown>
  server_values: Record<string, unknown>
  server_revision: number
  created_at: Timestamp
}

export interface SyncEngine {
  readonly status: Watchable<SyncStatus>
  readonly conflicts: Watchable<SyncConflict[]>
  /** Begin foreground sync triggers: startup, online, visibilitychange, interval while visible. */
  start(): void
  stop(): void
  /** Run one full cycle now (push mutations, upload originals, pull changes). */
  syncNow(): Promise<void>
  resolveConflict(conflictId: Id, choice: 'mine' | 'server'): Promise<void>
}

export interface AuthClient {
  session(): Promise<{ authenticated: boolean; expires_at: Timestamp | null }>
  /** Throws an Error whose message is user-facing (wrong password, too many attempts, offline). */
  login(password: string): Promise<void>
  logout(): Promise<void>
}

export interface ServerCollection {
  id: Id
  name: string
  status: 'active' | 'archived'
  entry_count: number
  photo_count: number
  stored_photo_bytes: number
  missing_originals: number
  updated_at: Timestamp
}

export interface ServerClient {
  listCollections(): Promise<ServerCollection[]>
  /** URL for a browser download (cookie-authenticated). */
  exportUrl(scope: { collectionId: Id } | 'all', opts?: { includeTrash?: boolean }): string
  removeServerCopy(collectionId: Id, confirmName: string): Promise<void>
}
