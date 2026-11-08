import { unzipSync } from 'fflate'
import { mkdirSync, writeFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import type { Collection, Entry, Photo } from '../types'
import { buildExport } from './build'
import { createZip } from './zip'

const at = '2026-11-08T07:00:00.000Z'
function crc32(data: Uint8Array): number {
  let c = 0xffffffff
  for (const byte of data) {
    c ^= byte
    for (let bit = 0; bit < 8; bit++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  }
  return (c ^ 0xffffffff) >>> 0
}
const collection = (id: string, name: string): Collection => ({
  id,
  name,
  description: '',
  status: 'active',
  storage_mode: 'local_only',
  next_sequence_number: 4,
  sort_order: null,
  sync_consented_at: null,
  last_exported_at: null,
  archived_at: null,
  created_at: at,
  updated_at: at,
  revision: 1,
  server_revision: null,
  sync_state: 'local_only',
})
const entry = (
  id: string,
  collection_id: string,
  sequence_number: number,
  deleted_at: string | null = null,
  quantity: string | null = '2',
): Entry => ({
  id,
  collection_id,
  sequence_number,
  title: '',
  quantity,
  unit: 'Boxes',
  count_detail: '',
  notes: '',
  expiration_date: null,
  dimensions: '',
  review_status: 'draft',
  deleted_at,
  created_at: at,
  updated_at: at,
  revision: 1,
  server_revision: null,
  sync_state: 'local_only',
})
const photo = (
  id: string,
  entry_id: string,
  collection_id: string,
  bytes: Uint8Array,
  captured_at = at,
  deleted_at: string | null = null,
): Photo => ({
  id,
  entry_id,
  collection_id,
  sort_order: 0,
  original_filename: `${id}.jpeg`,
  mime_type: 'image/jpeg',
  byte_size: bytes.length,
  width: 1,
  height: 1,
  sha256: '',
  crc32: 0,
  captured_at,
  capture_source: 'native_camera',
  caption: '',
  is_cover: true,
  deleted_at,
  created_at: at,
  updated_at: at,
  revision: 1,
  server_revision: null,
  sync_state: 'local_only',
  upload_state: 'not_needed',
  server_storage_key: null,
})

async function fixture(includeTrash = false) {
  const secondBytes = Uint8Array.from({ length: 128 }, (_, index) => index)
  const blobs = new Map<string, Blob>([
    ['P1', new Blob([new Uint8Array([1, 2, 3])])],
    ['P2', new Blob([secondBytes])],
    ['P3', new Blob([new Uint8Array([6])])],
  ])
  const allPhotos = [
    photo('P1', 'E1', 'C1', new Uint8Array([1, 2, 3])),
    photo('P2', 'E2', 'C1', secondBytes, '2026-11-09T07:00:00.000Z'),
    photo('P3', 'E3', 'C2', new Uint8Array([6]), at, at),
  ]
  for (const p of allPhotos) {
    const bytes = new Uint8Array(await blobs.get(p.id)!.arrayBuffer())
    p.crc32 = crc32(bytes)
    // Filled with Web Crypto so the fixture matches the actual original bytes.
    p.sha256 = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))]
      .map((x) => x.toString(16).padStart(2, '0'))
      .join('')
  }
  return buildExport(
    {
      collections: [collection('C1', 'Temple 2 / A04'), collection('C2', 'Other')],
      entries: [entry('E1', 'C1', 1), entry('E2', 'C1', 2, null, null), entry('E3', 'C2', 1, at)],
      photos: allPhotos,
      getOriginal: async (id) => blobs.get(id)!,
    },
    { scope: 'all', includeTrash, exportedAt: at, appVersion: '0.1.0', source: 'device' },
  )
}

describe('device export', () => {
  it('writes a STORE ZIP with ordered CSV/JSON and verified original bytes', async () => {
    const result = await fixture()
    if (process.env.W1_EXPORT_SAMPLE === '1') {
      mkdirSync('/tmp/codex-runs', { recursive: true })
      writeFileSync('/tmp/codex-runs/w1-export-sample.zip', new Uint8Array(await result.blob.arrayBuffer()))
    }
    const files = unzipSync(new Uint8Array(await result.blob.arrayBuffer()))
    expect(Object.keys(files)).toEqual([
      'capture-export/manifest.json',
      'capture-export/collections.csv',
      'capture-export/collections.json',
      'capture-export/entries.csv',
      'capture-export/entries.json',
      'capture-export/photos.csv',
      'capture-export/photos.json',
      'capture-export/photos/E1/P1.jpg',
      'capture-export/photos/E2/P2.jpg',
    ])
    expect(result.filename).toBe('kufang-capture-all-20261108-070000Z.zip')
    expect([...files['capture-export/entries.csv'].slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf])
    const entriesCsv = new TextDecoder().decode(files['capture-export/entries.csv'])
    expect(entriesCsv).toContain(
      'entry_id,collection_id,sequence_number,sequence_label,title,display_title,quantity,unit,count_detail,notes,expiration_date,dimensions,review_status,photo_count,created_at,updated_at,deleted_at\r\n',
    )
    expect(entriesCsv.indexOf('\r\nE1,')).toBeLessThan(entriesCsv.indexOf('\r\nE2,'))
    expect(entriesCsv).toContain('E2,C1,2,#0002,,Entry #0002,,Boxes,')
    expect(entriesCsv).not.toMatch(/(?<!\r)\n/)
    const entriesJson = JSON.parse(new TextDecoder().decode(files['capture-export/entries.json']))
    const photosJson = JSON.parse(new TextDecoder().decode(files['capture-export/photos.json']))
    expect(entriesJson.map((row: { entry_id: string }) => row.entry_id)).toEqual(['E1', 'E2'])
    expect(
      photosJson.every((row: { entry_id: string }) =>
        entriesJson.some((entry: { entry_id: string }) => entry.entry_id === row.entry_id),
      ),
    ).toBe(true)
    expect(photosJson.map((row: { photo_id: string }) => row.photo_id)).toEqual(['P1', 'P2'])
    expect(Object.keys(files)).toContain('capture-export/photos/E1/P1.jpg')
    expect([...files['capture-export/photos/E1/P1.jpg']]).toEqual([1, 2, 3])
    expect(files['capture-export/trash/entries.csv']).toBeUndefined()
    const manifest = JSON.parse(new TextDecoder().decode(files['capture-export/manifest.json']))
    expect(manifest.counts).toMatchObject({
      collections: 2,
      entries: 2,
      photos: 2,
      trash_entries: 0,
      trash_photos: 0,
    })
    expect(manifest.quantity_by_unit).toEqual([
      { collection_id: 'C1', unit: 'Boxes', total: '2', entry_count: 1 },
    ])
    for (const file of manifest.files) {
      const bytes = files[`capture-export/${file.path}`]
      expect(
        [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))]
          .map((x) => x.toString(16).padStart(2, '0'))
          .join(''),
      ).toBe(file.sha256)
    }
  })
  it('includes deleted entries and photos under trash when requested', async () => {
    const result = await fixture(true)
    const files = unzipSync(new Uint8Array(await result.blob.arrayBuffer()))
    expect(Object.keys(files)).toContain('capture-export/trash/photos/E3/P3.jpg')
    const manifest = JSON.parse(new TextDecoder().decode(files['capture-export/manifest.json']))
    expect(manifest.counts).toMatchObject({ trash_entries: 1, trash_photos: 1 })
  })
  it('writes valid ZIP64 end records when thresholds are forced', async () => {
    const member = {
      name: 'a',
      data: new Uint8Array([7]),
      crc32: crc32(new Uint8Array([7])),
      size: 1,
      mtime: at,
    }
    for (const options of [{ entryLimit: 0 }, { sizeLimit: 0 }]) {
      const blob = createZip([member], options)
      const bytes = new Uint8Array(await blob.arrayBuffer())
      expect(new DataView(bytes.buffer).getUint32(bytes.length - 22, true)).toBe(0x06054b50)
      expect([...unzipSync(bytes).a]).toEqual([7])
    }
  })
})
