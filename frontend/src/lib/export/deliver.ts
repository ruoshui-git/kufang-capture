/**
 * `needs_tap`: the share sheet refused to open because the tap that started the export is too old.
 * Browsers (iOS Safari in particular) only allow `navigator.share` within a few seconds of a user
 * gesture, and a large ZIP takes longer than that to build. The ZIP is ready; the caller must offer a
 * button and deliver again from that fresh tap.
 */
export type ExportDelivery = 'shared' | 'download' | 'cancelled' | 'needs_tap'

export async function deliverExport(blob: Blob, filename: string): Promise<ExportDelivery> {
  const file = new File([blob], filename, { type: 'application/zip' })
  if (typeof navigator !== 'undefined' && navigator.canShare?.({ files: [file] }) && navigator.share) {
    try {
      await navigator.share({ files: [file], title: filename })
      return 'shared'
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') return 'cancelled'
      if (error instanceof DOMException && error.name === 'NotAllowedError') return 'needs_tap'
      throw error
    }
  }
  const url = URL.createObjectURL(blob)
  try {
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = filename
    anchor.click()
  } finally {
    URL.revokeObjectURL(url)
  }
  return 'download'
}
