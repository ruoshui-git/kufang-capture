import { m } from '../paraglide/messages.js'
import { getLocale } from '../paraglide/runtime.js'

// The outbox and photo retry records keep their existing English representation.
export const storedSyncLocale = { locale: 'en' } as const

const fixedMessages = [
  m.core_sync_network_failed,
  m.core_sync_connection_stalled,
  m.core_sync_failed,
  m.core_server_space_low,
  m.core_sync_ack_incomplete,
  m.core_sync_conflict_without_revision,
  m.core_sync_original_missing,
  m.core_sync_checksum_mismatch,
]

const statusMessages = [
  m.core_session_request_failed,
  m.core_sync_request_failed,
  m.core_sync_check_photo_failed,
  m.core_sync_upload_failed,
  m.core_sync_changes_request_failed,
]

export function displaySyncError(stored: string): string {
  if (getLocale() === 'en') return stored
  const fixed = fixedMessages.find((message) => message({}, storedSyncLocale) === stored)
  if (fixed) return fixed()
  const match = /\((\d+)\)\.$/.exec(stored)
  if (match) {
    const inputs = { status: Number(match[1]) }
    const withStatus = statusMessages.find((message) => message(inputs, storedSyncLocale) === stored)
    if (withStatus) return withStatus(inputs)
  }
  return m.core_sync_failed()
}
