import { afterEach, describe, expect, it } from 'vitest'
import { createRepo, getCaptureDb } from './index'

let serial = 0
const names: string[] = []
async function first<T>(watchable: {
  subscribe(
    next: (value: T) => void,
    error?: (cause: unknown) => void,
  ): (() => void) | { unsubscribe(): void }
}) {
  return new Promise<T>((resolve, reject) => {
    let ready = false
    let subscription: (() => void) | { unsubscribe(): void } | undefined
    const stop = () => {
      if (typeof subscription === 'function') subscription()
      else subscription?.unsubscribe()
    }
    subscription = watchable.subscribe((value) => {
      ready = true
      stop()
      resolve(value)
    }, reject)
    if (ready) stop()
  })
}

afterEach(async () => {
  await Promise.all(names.splice(0).map((name) => getCaptureDb(name).delete()))
})

describe('watchImportSearch', () => {
  it('groups active same-mode placements, flags target and archive state, and searches normalized words', async () => {
    const name = `capture-import-search-${++serial}`
    names.push(name)
    const repo = createRepo({ databaseName: name })
    const target = await repo.createCollection({ name: 'Target room', storage_mode: 'local_only' })
    const sourceA = await repo.createCollection({ name: 'Ａ０３', storage_mode: 'local_only' })
    const sourceB = await repo.createCollection({ name: 'B01', storage_mode: 'local_only' })
    const otherMode = await repo.createCollection({ name: 'Synced room', storage_mode: 'synced' })
    const item = await repo.createEntry(sourceA.id, {
      title: 'ＡＢＣ 灯具',
      dimensions: '12 x 8 cm',
      notes: 'red brass',
      quantity: '36',
      unit: 'pieces',
      entry_notes: 'north shelf',
    })
    const second = (await repo.importEntries(sourceB.id, [item.id])).created[0]!
    await repo.updateEntry(second.id, { quantity: '2', unit: 'boxes', entry_notes: 'fragile' })
    const deletedSource = await repo.createEntry(sourceA.id, { title: 'Deleted lamp' })
    await repo.deleteEntry(deletedSource.id)
    const wrongMode = await repo.createEntry(otherMode.id, { title: 'ＡＢＣ 灯具' })
    const targetDeleted = (await repo.importEntries(target.id, [item.id])).created[0]!
    await repo.deleteEntry(targetDeleted.id)

    const rows = await first(repo.watchImportSearch(target.id, 'abc 灯具 #0001 north'))
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      entry: { item_id: item.item_id, title: 'ＡＢＣ 灯具' },
      already_here: false,
      archived: false,
    })
    expect(rows[0]?.placements.map((place) => place.collection_name)).toEqual(['B01', 'Ａ０３'])
    expect(rows[0]?.placements[0]).toMatchObject({ quantity: '2', unit: 'boxes' })
    expect(rows.map((row) => row.entry.id)).not.toContain(wrongMode.id)
    expect(await first(repo.watchImportSearch(target.id, 'abc 灯具'))).toHaveLength(1)
    expect(await first(repo.watchImportSearch(target.id, 'deleted lamp'))).toEqual([])
    expect(await first(repo.watchImportSearch(target.id, 'abc no-match'))).toEqual([])
    expect(await first(repo.watchImportSearch(target.id, '12 x 8 cm'))).toHaveLength(1)
    const targetActive = (await repo.importEntries(target.id, [item.id])).restored[0]!
    expect((await first(repo.watchImportSearch(target.id, '灯具')))[0]?.already_here).toBe(true)
    await repo.deleteEntry(targetActive.id)

    await repo.archiveCollection(sourceA.id)
    await repo.archiveCollection(sourceB.id)
    const archivedRows = await first(repo.watchImportSearch(target.id, '灯具'))
    expect(archivedRows[0]?.archived).toBe(true)
    await getCaptureDb(name).close()
  })
})
