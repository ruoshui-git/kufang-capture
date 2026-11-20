import type { CollectionSummary } from '$lib/types'

export function normalizeCollectionSearch(value: string): string {
  return value.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/\s+/gu, ' ').trim()
}

export function collectionMatches(summary: CollectionSummary, query: string): boolean {
  const tokens = normalizeCollectionSearch(query).split(' ').filter(Boolean)
  if (tokens.length === 0) return true

  const haystack = normalizeCollectionSearch(`${summary.collection.name} ${summary.collection.folder ?? ''}`)
  return tokens.every((token) => haystack.includes(token))
}
