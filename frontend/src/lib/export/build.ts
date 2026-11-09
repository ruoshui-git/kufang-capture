import type { Collection, Entry, Item, Photo } from '../types'
import { entryDisplayTitle, formatSequence } from '../types'
import { writeCsv } from './csv'
import { createZip, type ZipMember } from './zip'

export interface ExportInput {
  collections: Collection[]
  entries: Entry[]
  items: Item[]
  photos: Photo[]
  getOriginal(photoId: string): Promise<Blob>
}
export interface Manifest {
  format: 'kufang-capture-export'
  format_version: 2
  exported_at: string
  source: 'device'
  app_version: string
  scope: 'all' | 'selected'
  include_trash: boolean
  collections: Array<{ id: string; name: string; storage_mode: Collection['storage_mode'] }>
  counts: {
    collections: number
    items: number
    entries: number
    photos: number
    photo_bytes: number
    trash_entries: number
    trash_photos: number
  }
  quantity_by_unit: Array<{ collection_id: string; unit: string; total: string; entry_count: number }>
  files: Array<{ path: string; byte_size: number; sha256: string }>
  /** Always empty for device exports (server exports list photos without uploaded originals). */
  missing_originals: Array<{ photo_id: string; path: string }>
}
export interface BuildOptions {
  scope: 'all' | 'selected'
  includeTrash: boolean
  exportedAt: string
  appVersion: string
  source: 'device'
}

const encoder = new TextEncoder()
const collectionHeaders = [
  'collection_id',
  'name',
  'description',
  'status',
  'storage_mode',
  'next_sequence_number',
  'entry_count',
  'photo_count',
  'created_at',
  'updated_at',
  'archived_at',
]
const entryHeaders = [
  'entry_id',
  'item_id',
  'collection_id',
  'sequence_number',
  'sequence_label',
  'title',
  'display_title',
  'quantity',
  'unit',
  'count_detail',
  'notes',
  'expiration_date',
  'dimensions',
  'review_status',
  'photo_count',
  'created_at',
  'updated_at',
  'deleted_at',
]
const photoHeaders = [
  'photo_id',
  'item_id',
  'path',
  'original_filename',
  'mime_type',
  'byte_size',
  'sha256',
  'width',
  'height',
  'sort_order',
  'caption',
  'is_cover',
  'capture_source',
  'captured_at',
  'created_at',
  'deleted_at',
]

function hex(bytes: Uint8Array): string {
  return [...bytes].map((x) => x.toString(16).padStart(2, '0')).join('')
}
function rotr(x: number, n: number): number {
  return (x >>> n) | (x << (32 - n))
}
class Sha256 {
  private h = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]
  private buffer = new Uint8Array(64)
  private used = 0
  private bytes = 0
  update(chunk: Uint8Array): void {
    this.bytes += chunk.length
    let pos = 0
    while (pos < chunk.length) {
      const n = Math.min(64 - this.used, chunk.length - pos)
      this.buffer.set(chunk.subarray(pos, pos + n), this.used)
      this.used += n
      pos += n
      if (this.used === 64) {
        this.block(this.buffer)
        this.used = 0
      }
    }
  }
  private block(b: Uint8Array): void {
    const k = [
      0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
      0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
      0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
      0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
      0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
      0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
      0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
      0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
    ]
    const w = new Uint32Array(64)
    for (let i = 0; i < 16; i++)
      w[i] = ((b[i * 4]! << 24) | (b[i * 4 + 1]! << 16) | (b[i * 4 + 2]! << 8) | b[i * 4 + 3]!) >>> 0
    for (let i = 16; i < 64; i++) {
      const x = w[i - 15]!,
        y = w[i - 2]!
      w[i] =
        (w[i - 16]! +
          (rotr(x, 7) ^ rotr(x, 18) ^ (x >>> 3)) +
          w[i - 7]! +
          (rotr(y, 17) ^ rotr(y, 19) ^ (y >>> 10))) >>>
        0
    }
    let [a, bv, c, d, e, f, g, h] = this.h as [number, number, number, number, number, number, number, number]
    for (let i = 0; i < 64; i++) {
      const t1 = (h + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + ((e & f) ^ (~e & g)) + k[i]! + w[i]!) >>> 0
      const t2 = ((rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & bv) ^ (a & c) ^ (bv & c))) >>> 0
      ;[h, g, f, e, d, c, bv, a] = [g, f, e, (d + t1) >>> 0, c, bv, a, (t1 + t2) >>> 0]
    }
    this.h = this.h.map((x, i) => (x + [a, bv, c, d, e, f, g, h][i]!) >>> 0)
  }
  digest(): string {
    const bitLength = this.bytes * 8
    this.buffer[this.used++] = 0x80
    if (this.used > 56) {
      this.buffer.fill(0, this.used)
      this.block(this.buffer)
      this.used = 0
    }
    this.buffer.fill(0, this.used, 56)
    const view = new DataView(this.buffer.buffer)
    view.setUint32(56, Math.floor(bitLength / 0x100000000), false)
    view.setUint32(60, bitLength >>> 0, false)
    this.block(this.buffer)
    return this.h.map((x) => x.toString(16).padStart(8, '0')).join('')
  }
}
const crcTable = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()
function updateCrc(crc: number, bytes: Uint8Array): number {
  let c = crc
  for (const b of bytes) c = crcTable[(c ^ b) & 255]! ^ (c >>> 8)
  return c >>> 0
}
async function hashBlob(blob: Blob): Promise<{ sha256: string; crc32: number }> {
  const sha = new Sha256()
  let crc = 0xffffffff
  if (typeof blob.stream === 'function') {
    const reader = blob.stream().getReader()
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      sha.update(value)
      crc = updateCrc(crc, value)
    }
  } else {
    for (let offset = 0; offset < blob.size; offset += 1024 * 1024) {
      const chunk = new Uint8Array(await blob.slice(offset, offset + 1024 * 1024).arrayBuffer())
      sha.update(chunk)
      crc = updateCrc(crc, chunk)
    }
  }
  return { sha256: sha.digest(), crc32: (crc ^ 0xffffffff) >>> 0 }
}
function jsonBytes(value: unknown): Uint8Array {
  return encoder.encode(JSON.stringify(value, null, 2) + '\n')
}
function slug(value: string): string {
  return (
    value
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 40)
      .replace(/-$/g, '') || 'collection'
  )
}
function extension(photo: Photo): string {
  const known: Record<string, string> = {
    'image/jpeg': 'jpg',
    'image/heic': 'heic',
    'image/heif': 'heif',
    'image/png': 'png',
    'image/webp': 'webp',
    'image/gif': 'gif',
  }
  const knownExt = known[photo.mime_type.toLowerCase()]
  if (knownExt) return knownExt
  const ext = photo.original_filename.toLowerCase().match(/\.([a-z0-9]{1,5})$/)?.[1]
  return ext ?? 'bin'
}
function exactSum(values: string[]): string {
  const parsed = values
    .map((v) => {
      const m = v.trim().match(/^([+-]?)(\d+)(?:\.(\d*))?$/)
      if (!m) return null
      return { sign: m[1] === '-' ? -1n : 1n, whole: m[2], frac: m[3] ?? '' }
    })
    .filter((v): v is NonNullable<typeof v> => v !== null)
  const scale = Math.max(0, ...parsed.map((v) => v.frac.length))
  let total = parsed.reduce((sum, v) => sum + v.sign * BigInt(v.whole + v.frac.padEnd(scale, '0')), 0n)
  const negative = total < 0
  if (negative) total = -total
  let digits = total.toString().padStart(scale + 1, '0')
  const frac = scale ? digits.slice(-scale).replace(/0+$/, '') : ''
  const whole = scale ? digits.slice(0, -scale) : digits
  return `${negative ? '-' : ''}${whole}${frac ? `.${frac}` : ''}`
}
function csvRow<T>(
  rows: T[],
  transform: (row: T) => Record<string, unknown>,
): Array<Record<string, unknown>> {
  return rows.map(transform)
}

export async function buildExport(
  input: ExportInput,
  opts: BuildOptions,
): Promise<{ blob: Blob; filename: string; manifest: Manifest }> {
  const collections = [...input.collections].sort(
    (a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id),
  )
  if (opts.scope === 'selected' && collections.length !== 1) {
    throw new Error('A selected-scope export must contain exactly one collection')
  }
  const collectionIds = new Set(collections.map((c) => c.id))
  const entries = input.entries
    .filter((e) => collectionIds.has(e.collection_id))
    .sort(
      (a, b) =>
        collections.findIndex((c) => c.id === a.collection_id) -
          collections.findIndex((c) => c.id === b.collection_id) || a.sequence_number - b.sequence_number,
    )
  const itemMap = new Map(input.items.map((item) => [item.id, item]))
  const firstEntryIndex = new Map<string, number>()
  for (const [index, entry] of entries.entries()) {
    if (!firstEntryIndex.has(entry.item_id)) firstEntryIndex.set(entry.item_id, index)
    if (!itemMap.has(entry.item_id))
      throw new Error(`Item ${entry.item_id} is missing from the export snapshot.`)
  }
  const photos = input.photos
    .filter((p) => entries.some((e) => e.item_id === p.item_id))
    .sort(
      (a, b) =>
        firstEntryIndex.get(a.item_id)! - firstEntryIndex.get(b.item_id)! ||
        a.sort_order - b.sort_order ||
        a.captured_at.localeCompare(b.captured_at),
    )
  const activeEntries = entries.filter((e) => e.deleted_at === null)
  const activeItemIds = new Set(activeEntries.map((e) => e.item_id))
  const activePhotos = photos.filter((p) => p.deleted_at === null && activeItemIds.has(p.item_id))
  const trashEntries = entries.filter((e) => e.deleted_at !== null)
  const trashPhotos = photos.filter((p) => !activeItemIds.has(p.item_id) || p.deleted_at !== null)
  const exportPhotos = opts.includeTrash ? [...activePhotos, ...trashPhotos] : activePhotos
  const photoData = new Map<string, Blob>()
  const mismatches: string[] = []
  for (const photo of exportPhotos) {
    const blob = await input.getOriginal(photo.id)
    const actual = await hashBlob(blob)
    if (blob.size !== photo.byte_size || actual.sha256 !== photo.sha256 || actual.crc32 !== photo.crc32 >>> 0)
      mismatches.push(photo.id)
    photoData.set(photo.id, blob)
  }
  if (mismatches.length)
    throw new Error(`Original photo verification failed for photo ids: ${mismatches.join(', ')}`)
  const activePhotoCounts = new Map<string, number>()
  for (const p of activePhotos) activePhotoCounts.set(p.item_id, (activePhotoCounts.get(p.item_id) ?? 0) + 1)
  const trashPhotoCounts = new Map<string, number>()
  for (const p of trashPhotos) trashPhotoCounts.set(p.item_id, (trashPhotoCounts.get(p.item_id) ?? 0) + 1)
  const collectionRows = collections.map((c) => ({
    collection_id: c.id,
    name: c.name,
    description: c.description,
    status: c.status,
    storage_mode: c.storage_mode,
    next_sequence_number: c.next_sequence_number,
    entry_count: activeEntries.filter((e) => e.collection_id === c.id).length,
    photo_count: activePhotos.filter((p) =>
      activeEntries.some((e) => e.collection_id === c.id && e.item_id === p.item_id),
    ).length,
    created_at: c.created_at,
    updated_at: c.updated_at,
    archived_at: c.archived_at,
  }))
  const entryRows = (rows: Entry[], counts: Map<string, number>) =>
    csvRow(rows, (e) => ({
      entry_id: e.id,
      item_id: e.item_id,
      collection_id: e.collection_id,
      sequence_number: e.sequence_number,
      sequence_label: formatSequence(e.sequence_number),
      title: itemMap.get(e.item_id)?.title ?? '',
      display_title: entryDisplayTitle({ ...e, title: itemMap.get(e.item_id)?.title ?? '' }),
      quantity: e.quantity,
      unit: e.unit,
      count_detail: e.count_detail,
      notes: itemMap.get(e.item_id)?.notes ?? '',
      expiration_date: itemMap.get(e.item_id)?.expiration_date ?? null,
      dimensions: itemMap.get(e.item_id)?.dimensions ?? '',
      review_status: itemMap.get(e.item_id)?.review_status ?? 'draft',
      photo_count: counts.get(e.item_id) ?? 0,
      created_at: e.created_at,
      updated_at: [e.updated_at, itemMap.get(e.item_id)?.updated_at ?? e.updated_at].sort().at(-1),
      deleted_at: e.deleted_at,
    }))
  const makePhotoRows = (rows: Photo[], prefix: string) =>
    rows.map((p) => ({
      photo_id: p.id,
      item_id: p.item_id,
      path: `${prefix}photos/${p.item_id}/${p.id}.${extension(p)}`,
      original_filename: p.original_filename,
      mime_type: p.mime_type,
      byte_size: p.byte_size,
      sha256: p.sha256,
      width: p.width,
      height: p.height,
      sort_order: p.sort_order,
      caption: p.caption,
      is_cover: p.is_cover,
      capture_source: p.capture_source,
      captured_at: p.captured_at,
      created_at: p.created_at,
      deleted_at: p.deleted_at,
    }))
  const members: ZipMember[] = []
  const fileHashes: Manifest['files'] = []
  const add = async (path: string, data: Uint8Array | Blob, hash?: string) => {
    // Test for bytes, not `instanceof Blob`: Blobs from another realm (e.g. Node's in tests,
    // or structured-cloned) are still Blobs but fail that check.
    const bytes = ArrayBuffer.isView(data) ? (data as Uint8Array) : null
    const blob = bytes ? null : (data as Blob)
    const digest =
      hash ??
      hex(
        new Uint8Array(
          await crypto.subtle.digest('SHA-256', (bytes ?? (await blob!.arrayBuffer())) as BufferSource),
        ),
      )
    const size = bytes ? bytes.byteLength : blob!.size
    const crc = bytes ? crc32Bytes(bytes) : (await hashBlob(blob!)).crc32
    members.push({ name: `capture-export/${path}`, data, crc32: crc, size, mtime: opts.exportedAt })
    fileHashes.push({ path, byte_size: size, sha256: digest })
  }
  const addSet = async (
    base: string,
    entryRowsData: Array<Record<string, unknown>>,
    photoRowsData: Array<Record<string, unknown>>,
    originals: Photo[],
  ) => {
    const eCsv = writeCsv(entryHeaders, entryRowsData),
      eJson = jsonBytes(entryRowsData),
      pCsv = writeCsv(photoHeaders, photoRowsData),
      pJson = jsonBytes(photoRowsData)
    await add(`${base}entries.csv`, eCsv)
    await add(`${base}entries.json`, eJson)
    await add(`${base}photos.csv`, pCsv)
    await add(`${base}photos.json`, pJson)
    for (const p of originals) {
      const path = `${base}photos/${p.item_id}/${p.id}.${extension(p)}`
      await add(path, photoData.get(p.id)!, p.sha256)
    }
  }
  const cCsv = writeCsv(collectionHeaders, collectionRows),
    cJson = jsonBytes(collectionRows)
  // Manifest must be first; calculate member hashes before assembling it.
  await add('collections.csv', cCsv)
  await add('collections.json', cJson)
  const activeEntryRows = entryRows(activeEntries, activePhotoCounts),
    activePhotoRows = makePhotoRows(activePhotos, '')
  await addSet('', activeEntryRows, activePhotoRows, activePhotos)
  if (opts.includeTrash) {
    const tEntries = entryRows(trashEntries, trashPhotoCounts)
    const tPhotos = makePhotoRows(trashPhotos, 'trash/')
    await addSet('trash/', tEntries, tPhotos, trashPhotos)
  }
  const quantities: Manifest['quantity_by_unit'] = []
  for (const c of collections) {
    const groups = new Map<string, Entry[]>()
    for (const e of activeEntries.filter((x) => x.collection_id === c.id && x.quantity !== null)) {
      const key = e.unit.trim().toLowerCase()
      groups.set(key, [...(groups.get(key) ?? []), e])
    }
    for (const [, group] of [...groups].sort(([a], [b]) => a.localeCompare(b))) {
      const recent = [...group].sort((a, b) => b.updated_at.localeCompare(a.updated_at))[0]!
      quantities.push({
        collection_id: c.id,
        unit: recent.unit,
        total: exactSum(group.map((e) => e.quantity!)),
        entry_count: group.length,
      })
    }
  }
  const manifest: Manifest = {
    format: 'kufang-capture-export',
    format_version: 2,
    exported_at: opts.exportedAt,
    source: opts.source,
    app_version: opts.appVersion,
    scope: opts.scope,
    include_trash: opts.includeTrash,
    collections: collections.map((c) => ({ id: c.id, name: c.name, storage_mode: c.storage_mode })),
    counts: {
      collections: collections.length,
      items: new Set(activeEntries.map((e) => e.item_id)).size,
      entries: activeEntries.length,
      photos: activePhotos.length,
      photo_bytes: activePhotos.reduce((sum, p) => sum + p.byte_size, 0),
      trash_entries: opts.includeTrash ? trashEntries.length : 0,
      trash_photos: opts.includeTrash ? trashPhotos.length : 0,
    },
    quantity_by_unit: quantities,
    files: fileHashes,
    missing_originals: [],
  }
  const manifestBytes = jsonBytes(manifest)
  const allMembers: ZipMember[] = [
    {
      name: 'capture-export/manifest.json',
      data: manifestBytes,
      crc32: crc32Bytes(manifestBytes),
      size: manifestBytes.length,
      mtime: opts.exportedAt,
    },
    ...members,
  ]
  const stamp = opts.exportedAt
    .replace(/[-:]/g, '')
    .replace('T', '-')
    .replace(/\.\d{3}Z$/, 'Z')
  const slugPart = opts.scope === 'all' ? 'all' : slug(collections[0]?.name ?? 'collection')
  return { blob: createZip(allMembers), filename: `kufang-capture-${slugPart}-${stamp}.zip`, manifest }
}
function crc32Bytes(bytes: Uint8Array): number {
  return (updateCrc(0xffffffff, bytes) ^ 0xffffffff) >>> 0
}
