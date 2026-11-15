import type { Collection, Item, Photo } from '../types'

export function sanitize(value: string): string {
  let result = value
    .normalize('NFC')
    .replace(/[\u0000-\u001f\u007f/\\:*?"<>|]/g, ' ')
    .replace(/\s+/gu, ' ')
    .replace(/^[ .]+|[ .]+$/g, '')
  result = Array.from(result)
    .slice(0, 60)
    .join('')
    .replace(/[ .]+$/g, '')
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i.test(result)) result += '_'
  return result
}

export interface PathEntry {
  id: string
  item_id: string
  collection_id: string
  sequence_number: number
}

export interface PathPhoto {
  photo_id: string
  item_id: string
  extension: string
}

export interface AssignedPaths {
  collectionDirs: Map<string, string>
  entryDirs: Map<string, string>
  photoDirs: Map<string, string>
  photoPaths: Map<string, string>
}

export function assignPaths(
  collections: Collection[],
  items: Item[],
  photos: Photo[],
  entryOrder: PathEntry[],
  activeItemIds: Set<string>,
  isTrash: boolean,
  extensions: Map<string, string>,
): AssignedPaths {
  const used = new Set<string>()
  const collectionDirs = new Map<string, string>()
  for (const collection of collections) {
    const base = sanitize(collection.name) || 'Collection'
    let name = base
    let suffix = 2
    while (used.has(fold(name))) {
      name = `${base} (${suffix++})`
    }
    used.add(fold(name))
    collectionDirs.set(collection.id, name)
  }
  const itemById = new Map(items.map((item) => [item.id, item]))
  const homeByItem = new Map<string, PathEntry>()
  for (const row of entryOrder) {
    if (!homeByItem.has(row.item_id) && (!isTrash || activeItemIds.has(row.item_id))) {
      homeByItem.set(row.item_id, row)
    }
  }
  if (isTrash) {
    for (const row of entryOrder) if (!homeByItem.has(row.item_id)) homeByItem.set(row.item_id, row)
  }
  const entryDirs = new Map<string, string>()
  for (const row of entryOrder) {
    const home = homeByItem.get(row.item_id)
    if (!home) continue
    // A title that sanitizes to nothing (e.g. '???') must not leave a trailing space.
    const title = sanitize(itemById.get(row.item_id)?.title ?? '')
    entryDirs.set(home.id, `${String(home.sequence_number).padStart(4, '0')}${title ? ` ${title}` : ''}`)
  }
  const photoDirs = new Map<string, string>()
  const photoItemIds = new Set(photos.map((photo) => photo.item_id))
  for (const row of entryOrder) {
    const home = homeByItem.get(row.item_id)
    if (!home || !photoItemIds.has(row.item_id)) continue
    const dir = `${isTrash ? 'trash/' : ''}photos/${collectionDirs.get(home.collection_id)}/${entryDirs.get(home.id)}`
    photoDirs.set(row.id, dir)
  }
  const grouped = new Map<string, PathPhoto[]>()
  for (const photo of photos)
    grouped.set(photo.item_id, [
      ...(grouped.get(photo.item_id) ?? []),
      {
        photo_id: photo.id,
        item_id: photo.item_id,
        extension: extensions.get(photo.id) ?? 'bin',
      },
    ])
  const photoPaths = new Map<string, string>()
  for (const [itemId, list] of grouped) {
    const home = homeByItem.get(itemId)
    if (!home) continue
    const dir =
      photoDirs.get(home.id) ??
      `${isTrash ? 'trash/' : ''}photos/${collectionDirs.get(home.collection_id)}/${entryDirs.get(home.id)}`
    list.forEach((photo, index) => {
      photoPaths.set(photo.photo_id, `${dir}/${String(index + 1).padStart(2, '0')}.${photo.extension}`)
    })
  }
  return { collectionDirs, entryDirs, photoDirs, photoPaths }
}

function fold(value: string): string {
  return value.normalize('NFC').toLocaleLowerCase('und').replaceAll('ß', 'ss').replaceAll('ς', 'σ')
}
