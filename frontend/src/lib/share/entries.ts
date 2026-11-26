import { addDecimals, normalizeUnit } from '$lib/summary'
import type { SharedEntry, SharedPhoto } from './contract'

export function summarizeQuantities(entries: SharedEntry[]) {
  const totals = new Map<string, { unit: string; total: string; updated: string }>()
  for (const { quantity, unit, updated_at } of entries) {
    if (!quantity?.trim()) continue
    const key = normalizeUnit(unit)
    const previous = totals.get(key)
    if (!previous) totals.set(key, { unit: unit.trim(), total: quantity.trim(), updated: updated_at })
    else {
      previous.total = addDecimals(previous.total, quantity)
      if (updated_at >= previous.updated) {
        previous.unit = unit.trim()
        previous.updated = updated_at
      }
    }
  }
  return [...totals.values()].map(({ unit, total }) => ({ unit, total }))
}

export function matchesShareSearch(entry: SharedEntry, query: string) {
  const term = query.trim().toLocaleLowerCase()
  if (!term) return true
  if (/^#?\d+$/.test(term) && Number(term.replace(/^#/, '')) === entry.sequence_number) return true
  return entry.title.toLocaleLowerCase().includes(term)
}

// SharedPhoto has the comparator's three fields, but not the rest of the app's Photo record.
export function sharedPhotoOrder(a: SharedPhoto, b: SharedPhoto) {
  return (
    Number(b.is_cover) - Number(a.is_cover) ||
    b.captured_at.localeCompare(a.captured_at) ||
    b.id.localeCompare(a.id)
  )
}
