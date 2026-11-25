import type { CollectionStatus, EntryRow, Id } from '../types'
import type { ImportSearchPlacement, ImportSearchRow } from '../repo'

export interface ImportSearchSource extends EntryRow {
  collection_id: Id
  collection_name: string
  collection_status: CollectionStatus
}

export function normalizeImportSearch(value: string): string {
  return value.normalize('NFKC').toLocaleLowerCase()
}

export function buildImportSearchRows(
  sources: ImportSearchSource[],
  targetItemIds: Set<Id>,
  query: string,
): ImportSearchRow[] {
  const words = normalizeImportSearch(query).trim().split(/\s+/u).filter(Boolean)
  const groups = new Map<Id, ImportSearchSource[]>()
  for (const source of sources) {
    const group = groups.get(source.entry.item_id) ?? []
    group.push(source)
    groups.set(source.entry.item_id, group)
  }

  const rows: ImportSearchRow[] = []
  for (const [itemId, group] of groups) {
    group.sort(
      (a, b) =>
        b.last_edited_at.localeCompare(a.last_edited_at) ||
        b.entry.updated_at.localeCompare(a.entry.updated_at) ||
        b.entry.sequence_number - a.entry.sequence_number,
    )
    const representative = group[0]!
    const placements: ImportSearchPlacement[] = group.map((source) => ({
      collection_id: source.collection_id,
      collection_name: source.collection_name,
      sequence_number: source.entry.sequence_number,
      quantity: source.entry.quantity,
      unit: source.entry.unit,
      archived: source.collection_status === 'archived',
      last_edited_at: source.last_edited_at,
    }))
    const searchable = normalizeImportSearch(
      [
        ...group.flatMap((source) => [
          source.entry.title,
          source.entry.notes,
          source.entry.entry_notes,
          source.entry.dimensions,
          source.entry.count_detail,
          source.entry.unit,
        ]),
        ...placements.flatMap((placement) => [
          String(placement.sequence_number),
          `#${String(placement.sequence_number).padStart(4, '0')}`,
          placement.collection_name,
        ]),
      ].join(' '),
    )
    if (words.some((word) => !searchable.includes(word))) continue
    rows.push({
      ...representative,
      placements,
      archived: placements.every((placement) => placement.archived),
      already_here: targetItemIds.has(itemId),
    })
  }

  return rows.sort((a, b) => {
    const titleA = normalizeImportSearch(a.entry.title)
    const titleB = normalizeImportSearch(b.entry.title)
    const titleMatchA = words.length > 0 && words.every((word) => titleA.includes(word))
    const titleMatchB = words.length > 0 && words.every((word) => titleB.includes(word))
    return Number(titleMatchB) - Number(titleMatchA) || b.last_edited_at.localeCompare(a.last_edited_at)
  })
}
