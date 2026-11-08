import type { PhotoBlob } from '../types'

export interface ImageDimensions {
  width: number
  height: number
  thumbnail: Blob
}

export type ImageProcessor = (blob: Blob) => Promise<ImageDimensions>

/** Browser image decoding and a separate ~320px JPEG preview. */
export const defaultImageProcessor: ImageProcessor = async (blob) => {
  let bitmap: ImageBitmap | null = null
  let source: CanvasImageSource
  let width: number
  let height: number
  if (typeof createImageBitmap === 'function') {
    bitmap = await createImageBitmap(blob)
    source = bitmap
    width = bitmap.width
    height = bitmap.height
  } else {
    const image = await loadImage(blob)
    source = image
    width = image.naturalWidth
    height = image.naturalHeight
  }
  const scale = Math.min(1, 320 / Math.max(width, height))
  const isOffscreen = typeof OffscreenCanvas !== 'undefined'
  const canvas = isOffscreen
    ? new OffscreenCanvas(Math.max(1, Math.round(width * scale)), Math.max(1, Math.round(height * scale)))
    : Object.assign(document.createElement('canvas'), {
        width: Math.max(1, Math.round(width * scale)),
        height: Math.max(1, Math.round(height * scale)),
      })
  const context = canvas.getContext('2d')
  if (!context) throw new Error('Could not create thumbnail canvas')
  context.drawImage(source, 0, 0, canvas.width, canvas.height)
  const thumbnail = isOffscreen
    ? await (canvas as OffscreenCanvas).convertToBlob({ type: 'image/jpeg', quality: 0.82 })
    : await canvasBlob(canvas as HTMLCanvasElement)
  bitmap?.close()
  return { width, height, thumbnail }
}

function loadImage(blob: Blob): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image()
    const url = URL.createObjectURL(blob)
    image.onload = () => {
      URL.revokeObjectURL(url)
      resolve(image)
    }
    image.onerror = () => {
      URL.revokeObjectURL(url)
      reject(new Error('Could not decode image'))
    }
    image.src = url
  })
}

function canvasBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) =>
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error('Could not encode thumbnail'))),
      'image/jpeg',
      0.82,
    ),
  )
}

const crcTable = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

export async function crc32(blob: Blob): Promise<number> {
  let crc = 0xffffffff
  const chunkSize = 1024 * 1024
  for (let offset = 0; offset < blob.size; offset += chunkSize) {
    const bytes = new Uint8Array(await readBlob(blob.slice(offset, offset + chunkSize)))
    for (const byte of bytes) crc = crcTable[(crc ^ byte) & 0xff]! ^ (crc >>> 8)
  }
  return (crc ^ 0xffffffff) >>> 0
}

export async function sha256(blob: Blob): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', await readBlob(blob))
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

export function readBlob(blob: Blob): Promise<ArrayBuffer> {
  if (typeof blob.arrayBuffer === 'function') return blob.arrayBuffer()
  if (typeof Response !== 'undefined') {
    try {
      return new Response(blob).arrayBuffer()
    } catch {
      /* Fall back for browsers without Blob response support. */
    }
  }
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result as ArrayBuffer)
    reader.onerror = () => reject(reader.error ?? new Error('Could not read blob'))
    reader.readAsArrayBuffer(blob)
  })
}

/** Small LRU URL cache; callers should release all URLs when the app shuts down. */
class ObjectUrlCache {
  private readonly urls = new Map<string, string>()
  constructor(private readonly limit: number) {}
  async get(key: string, load: () => Promise<Blob | undefined>): Promise<string | null> {
    const present = this.urls.get(key)
    if (present) {
      this.urls.delete(key)
      this.urls.set(key, present)
      return present
    }
    const blob = await load()
    if (!blob) return null
    const url = URL.createObjectURL(blob)
    this.urls.set(key, url)
    while (this.urls.size > this.limit) {
      const oldest = this.urls.keys().next().value as string | undefined
      if (oldest === undefined) break
      URL.revokeObjectURL(this.urls.get(oldest)!)
      this.urls.delete(oldest)
    }
    return url
  }
  clear(): void {
    for (const url of this.urls.values()) URL.revokeObjectURL(url)
    this.urls.clear()
  }
}

let blobLoader: (id: string) => Promise<PhotoBlob | undefined> = async () => undefined
const thumbnails = new ObjectUrlCache(300)
const originals = new ObjectUrlCache(10)
export function configurePhotoBlobLoader(loader: typeof blobLoader): void {
  blobLoader = loader
}
export function thumbnailUrl(photoId: string): Promise<string | null> {
  return thumbnails.get(photoId, async () => (await blobLoader(photoId))?.thumbnail ?? undefined)
}
export function originalUrl(photoId: string): Promise<string | null> {
  return originals.get(photoId, async () => (await blobLoader(photoId))?.original ?? undefined)
}
export function clearPhotoUrlCaches(): void {
  thumbnails.clear()
  originals.clear()
}
