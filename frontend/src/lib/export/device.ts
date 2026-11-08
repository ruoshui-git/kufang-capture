// Device export: builds a portable ZIP purely from IndexedDB (never contacts
// the server, so it works offline and for Local Only collections) and hands it
// to the share sheet / download.
import { repo as defaultRepo } from '../db'
import type { Repo } from '../repo'
import type { Id } from '../types'
import { buildExport, type Manifest } from './build'
import { deliverExport, type ExportDelivery } from './deliver'

export interface DeviceExportResult {
  delivery: ExportDelivery
  filename: string
  manifest: Manifest
}

export async function exportFromDevice(
  scope: Id[] | 'all',
  opts: { includeTrash?: boolean } = {},
  deps: { repo?: Repo; deliver?: typeof deliverExport; now?: () => Date } = {},
): Promise<DeviceExportResult> {
  const repo = deps.repo ?? defaultRepo
  const deliver = deps.deliver ?? deliverExport
  const exportedAt = (deps.now?.() ?? new Date()).toISOString()
  const data = await repo.readForExport(scope)
  if (!data.collections.length) throw new Error('Nothing to export: the collection was not found.')
  const { blob, filename, manifest } = await buildExport(
    {
      ...data,
      async getOriginal(photoId) {
        const stored = await repo.getPhotoBlob(photoId)
        if (!stored) throw new Error(`Original photo ${photoId} is missing on this device.`)
        return stored.original
      },
    },
    {
      scope: scope === 'all' ? 'all' : 'selected',
      includeTrash: opts.includeTrash ?? false,
      exportedAt,
      appVersion: import.meta.env.VITE_APP_VERSION ?? 'dev',
      source: 'device',
    },
  )
  const delivery = await deliver(blob, filename)
  if (delivery !== 'cancelled') {
    await repo.markExported(
      data.collections.map((c) => c.id),
      exportedAt,
    )
  }
  return { delivery, filename, manifest }
}
