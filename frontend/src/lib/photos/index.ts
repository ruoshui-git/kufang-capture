import { m } from '../paraglide/messages.js'
import { getLocale } from '../paraglide/runtime.js'
import type { PhotoBlob } from '../types'
import { accountGate, fetchAccountPhoto, photoAccount } from '../sync/binding'

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
  if (!context) throw new Error(m.core_thumbnail_canvas_failed())
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
      reject(new Error(m.core_photo_decode_failed()))
    }
    image.src = url
  })
}

function canvasBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) =>
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error(m.core_thumbnail_encode_failed()))),
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
    reader.onerror = () =>
      reject((getLocale() === 'en' && reader.error) || new Error(m.core_photo_read_failed()))
    reader.readAsArrayBuffer(blob)
  })
}

/** Small LRU URL cache; callers should release all URLs when the app shuts down. */
class ObjectUrlCache {
  private readonly urls = new Map<string, string>()
  private generation = 0
  constructor(private readonly limit: number) {}
  async get(key: string, load: () => Promise<Blob | undefined>): Promise<string | null> {
    const present = this.urls.get(key)
    if (present) {
      this.urls.delete(key)
      this.urls.set(key, present)
      return present
    }
    const generation = this.generation
    const loaded = await load()
    if (!loaded || generation !== this.generation) return null
    const concurrent = this.urls.get(key)
    if (concurrent) return concurrent
    const url = URL.createObjectURL(loaded)
    this.urls.set(key, url)
    while (this.urls.size > this.limit) {
      const oldest = this.urls.keys().next().value as string | undefined
      if (oldest === undefined) break
      const stale = this.urls.get(oldest)!
      URL.revokeObjectURL(stale)
      this.urls.delete(oldest)
    }
    return url
  }
  delete(key: string): void {
    const url = this.urls.get(key)
    if (url) URL.revokeObjectURL(url)
    this.urls.delete(key)
  }
  clear(): void {
    this.generation++
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
const remoteThumbnails = new ObjectUrlCache(300)
const remoteOriginals = new ObjectUrlCache(10)
let remoteAccount: string | null = null
let observingRemoteAccount = false

async function remoteUrl(photoId: string, kind: 'original' | 'thumbnail') {
  if (!observingRemoteAccount) {
    observingRemoteAccount = true
    photoAccount.subscribe((id) => {
      if (id !== remoteAccount) {
        remoteAccount = id
        remoteThumbnails.clear()
        remoteOriginals.clear()
      }
    })
  }
  const access = accountGate.current
  if (access.kind === 'blocked' || access.kind === 'signed_out') return null
  const cache = kind === 'thumbnail' ? remoteThumbnails : remoteOriginals
  try {
    // Verify the current cookie before returning a cached remote photo.
    accountGate.requireReady(await accountGate.check(fetch))
    return await cache.get(photoId, async () => {
      const response = await fetchAccountPhoto(photoId, kind)
      return response.ok ? response.blob() : undefined
    })
  } catch {
    return null
  }
}

/** Display a local thumbnail or original first, then fetch a preview for a synced photo. */
export async function thumbnailUrl(photoId: string): Promise<string | null> {
  const local = await thumbnails.get(photoId, async () => {
    const blob = await blobLoader(photoId)
    return blob?.thumbnail ?? blob?.original
  })
  return local ?? remoteUrl(photoId, 'thumbnail')
}
export async function originalUrl(photoId: string): Promise<string | null> {
  const local = await originals.get(photoId, async () => (await blobLoader(photoId))?.original)
  return local ?? remoteUrl(photoId, 'original')
}
/** Forget a cached preview so the next request picks up a newly generated thumbnail. */
export function invalidateThumbnail(photoId: string): void {
  thumbnails.delete(photoId)
  remoteThumbnails.delete(photoId)
}
export function clearPhotoUrlCaches(): void {
  thumbnails.clear()
  originals.clear()
  remoteThumbnails.clear()
  remoteOriginals.clear()
}
