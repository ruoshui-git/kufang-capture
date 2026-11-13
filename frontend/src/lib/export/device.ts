// Device export: builds a portable ZIP from IndexedDB and hands it to the share
// sheet / download. Originals stored on this device are used as is, so the export
// works offline. An original that is only on the server (captured on another
// device, synced here as metadata) is downloaded for the ZIP, and only for
// collections set to sync: Local Only data never causes a request.
import { repo as defaultRepo } from '../db'
import type { Repo } from '../repo'
import type { Id, Photo } from '../types'
import { buildExport, type Manifest } from './build'
import { deliverExport, type ExportDelivery } from './deliver'

export interface DeviceExportResult {
  delivery: ExportDelivery
  filename: string
  manifest: Manifest
  byteSize: number
  /** Present when `delivery` is `needs_tap`: call it from a fresh tap to share the ZIP already built. */
  deliverAgain?: () => Promise<ExportDelivery>
}

/** Downloads a server-held original. Resolves to the bytes, or rejects with a user-facing message. */
export type FetchOriginal = (photoId: Id) => Promise<Blob>

export const fetchServerOriginal: FetchOriginal = async (photoId) => {
  let response: Response
  try {
    response = await fetch(`/api/photos/${encodeURIComponent(photoId)}/original`, {
      credentials: 'same-origin',
    })
  } catch {
    throw new Error(
      `Photo ${photoId} is only on the server and couldn't be downloaded. Check your connection, or use Server exports.`,
    )
  }
  if (response.status === 401) throw new Error('Sign in to include photos stored on the server.')
  if (!response.ok)
    throw new Error(
      `Photo ${photoId} is only on the server and couldn't be downloaded (HTTP ${response.status}). Try again, or use Server exports.`,
    )
  return response.blob()
}

export async function exportFromDevice(
  scope: Id[] | 'all',
  opts: { includeTrash?: boolean; onProgress?: (done: number, total: number) => void } = {},
  deps: { repo?: Repo; deliver?: typeof deliverExport; now?: () => Date; fetchOriginal?: FetchOriginal } = {},
): Promise<DeviceExportResult> {
  const repo = deps.repo ?? defaultRepo
  const deliver = deps.deliver ?? deliverExport
  const exportedAt = (deps.now?.() ?? new Date()).toISOString()
  const data = await repo.readForExport(scope)
  if (!data.collections.length) throw new Error('Nothing to export: the collection was not found.')
  const fetchOriginal = deps.fetchOriginal ?? fetchServerOriginal
  // An item can be in several collections, all of one storage mode; fetch only when none is Local Only.
  const localOnlyCollections = new Set(
    data.collections.filter((c) => c.storage_mode === 'local_only').map((c) => c.id),
  )
  const localOnlyItems = new Set(
    data.entries.filter((e) => localOnlyCollections.has(e.collection_id)).map((e) => e.item_id),
  )
  const photosById = new Map<Id, Photo>(data.photos.map((p) => [p.id, p]))
  const { blob, filename, manifest } = await buildExport(
    {
      ...data,
      async getOriginal(photoId) {
        const stored = await repo.getPhotoBlob(photoId)
        if (stored) return stored.original
        const photo = photosById.get(photoId)
        // buildExport verifies size, SHA-256 and CRC-32, so server bytes are checked like local ones.
        if (photo?.upload_state === 'uploaded' && !localOnlyItems.has(photo.item_id))
          return fetchOriginal(photoId)
        throw new Error(`Original photo ${photoId} is missing on this device.`)
      },
    },
    {
      scope: scope === 'all' ? 'all' : 'selected',
      includeTrash: opts.includeTrash ?? false,
      exportedAt,
      appVersion: import.meta.env.VITE_APP_VERSION ?? 'dev',
      source: 'device',
      onProgress: opts.onProgress,
    },
  )
  // An export counts (for the Clear guard) only once the ZIP has actually left the app.
  const deliverAndRecord = async (): Promise<ExportDelivery> => {
    const delivery = await deliver(blob, filename)
    if (delivery === 'shared' || delivery === 'download') {
      await repo.markExported(
        data.collections.map((c) => c.id),
        exportedAt,
      )
    }
    return delivery
  }
  const delivery = await deliverAndRecord()
  return {
    delivery,
    filename,
    manifest,
    byteSize: blob.size,
    ...(delivery === 'needs_tap' ? { deliverAgain: deliverAndRecord } : {}),
  }
}
