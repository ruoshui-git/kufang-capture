/**
 * `needs_tap`: the share sheet refused to open because the tap that started the export is too old.
 * Browsers (iOS Safari in particular) only allow `navigator.share` within a few seconds of a user
 * gesture, and a large ZIP takes longer than that to build. The ZIP is ready; the caller must offer a
 * button and deliver again from that fresh tap.
 */
export type ExportDelivery = 'shared' | 'download' | 'cancelled' | 'needs_tap'

export async function deliverExport(
  blob: Blob,
  filename: string,
  opts: { fromFreshTap?: boolean; forceDownload?: boolean } = {},
): Promise<ExportDelivery> {
  if (opts.forceDownload) return downloadExport(blob, filename)
  const file = new File([blob], filename, { type: 'application/zip' })
  if (typeof navigator !== 'undefined' && navigator.canShare?.({ files: [file] }) && navigator.share) {
    try {
      await navigator.share({ files: [file], title: filename })
      return 'shared'
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') return 'cancelled'
      if (error instanceof DOMException && error.name === 'NotAllowedError') {
        if (opts.fromFreshTap || navigator.userActivation?.isActive === true)
          return downloadExport(blob, filename)
        return 'needs_tap'
      }
      throw error
    }
  }
  return downloadExport(blob, filename)
}

function downloadExport(blob: Blob, filename: string): ExportDelivery {
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  anchor.rel = 'noopener'
  anchor.hidden = true
  document.body.append(anchor)
  try {
    anchor.click()
  } finally {
    anchor.remove()
    setTimeout(() => URL.revokeObjectURL(url), 60_000)
  }
  return 'download'
}
