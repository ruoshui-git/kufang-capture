export type ExportDelivery = 'shared' | 'download' | 'cancelled'

export async function deliverExport(blob: Blob, filename: string): Promise<ExportDelivery> {
  const file = new File([blob], filename, { type: 'application/zip' })
  if (typeof navigator !== 'undefined' && navigator.canShare?.({ files: [file] }) && navigator.share) {
    try {
      await navigator.share({ files: [file], title: filename })
      return 'shared'
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') return 'cancelled'
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
