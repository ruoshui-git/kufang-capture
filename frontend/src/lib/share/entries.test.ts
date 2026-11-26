import { describe, expect, it } from 'vitest'
import type { SharedEntry, SharedPhoto } from './contract'
import { matchesShareSearch, sharedPhotoOrder, summarizeQuantities } from './entries'

const timestamp = '2026-11-26T15:00:00.000Z'
const entry: SharedEntry = {
  id: 'entry',
  item_id: 'item',
  sequence_number: 42,
  quantity: '1.1',
  unit: ' Boxes ',
  count_detail: '',
  title: 'Incense',
  notes: '',
  entry_notes: '',
  expiration_date: null,
  dimensions: '',
  review_status: 'needs_review',
  created_at: timestamp,
  updated_at: timestamp,
  photos: [],
}
const photo: SharedPhoto = {
  id: 'A',
  captured_at: timestamp,
  is_cover: false,
  byte_size: 30,
  mime_type: 'image/jpeg',
  caption: '',
  width: null,
  height: null,
  sort_order: 0,
  stored: true,
}

describe('shared collections', () => {
  it('searches unpadded, padded and tagged sequences as well as titles', () => {
    for (const query of ['42', '#42', '0042', '#0042', ' inCense '])
      expect(matchesShareSearch(entry, query)).toBe(true)
    expect(matchesShareSearch(entry, '4')).toBe(false)
  })

  it('keeps blank quantities out, keeps zero in, and sums exactly within each unit', () => {
    expect(
      summarizeQuantities([
        entry,
        { ...entry, quantity: '2.25', unit: 'boxes' },
        { ...entry, quantity: '4', unit: 'pieces' },
        { ...entry, quantity: null, unit: 'jars' },
        { ...entry, quantity: ' ', unit: 'bags' },
        { ...entry, quantity: '0', unit: '' },
      ]).map(({ unit, total }) => [unit, total]),
    ).toEqual([
      ['boxes', '3.35'],
      ['pieces', '4'],
      ['', '0'],
    ])
  })

  it('shows the cover first, then newest photos with a stable ID tie-break', () => {
    expect(
      [
        photo,
        { ...photo, id: 'B' },
        { ...photo, id: 'C', captured_at: '2026-11-25', is_cover: true },
        { ...photo, id: 'D', captured_at: '2026-11-27' },
      ]
        .sort(sharedPhotoOrder)
        .map(({ id }) => id),
    ).toEqual(['C', 'D', 'B', 'A'])
  })
})
