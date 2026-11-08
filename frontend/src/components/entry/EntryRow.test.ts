import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte'
import { afterEach, describe, expect, it, vi } from 'vitest'
import EntryRow from './EntryRow.svelte'

vi.mock('$lib/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('$lib/db')>()
  return { repo: actual.createRepo({ databaseName: `entry-row-race-${Date.now()}` }) }
})
vi.mock('$lib/camera', () => ({ pickPhotos: vi.fn(() => Promise.resolve([])) }))
vi.mock('$lib/sync', () => ({ syncEngine: { status: { subscribe: () => () => {} } } }))
const { repo } = await import('$lib/db')

afterEach(cleanup)

async function first<T>(watch: {
  subscribe: (next: (value: T) => void) => (() => void) | { unsubscribe(): void }
}) {
  return new Promise<T>((resolve) => {
    const subscription = watch.subscribe((value) => {
      if (typeof subscription === 'function') subscription()
      else subscription.unsubscribe()
      resolve(value)
    })
  })
}

describe('entry row inline editing', () => {
  it('preserves a dirty quantity through focus changes, live updates, and a row remount', async () => {
    const collection = await repo.createCollection({ name: `Room ${Date.now()}`, storage_mode: 'local_only' })
    const entry = await repo.createEntry(collection.id)
    const query = { search: '', filter: 'all' as const, sort: 'newest' as const }
    const [row] = await first(repo.watchEntryRows(collection.id, query))
    const props = {
      row: row!,
      units: [],
      ondetails: () => {},
      onviewer: () => {},
      ondelete: () => {},
    }
    const updateEntry = repo.updateEntry.bind(repo)
    let releaseQuantityWrite!: () => void
    let quantityWriteStarted!: () => void
    const quantityWriteGate = new Promise<void>((resolve) => (releaseQuantityWrite = resolve))
    const quantityWriteStartedPromise = new Promise<void>((resolve) => (quantityWriteStarted = resolve))
    repo.updateEntry = async (id, patch) => {
      if (patch.quantity === '5') {
        quantityWriteStarted()
        await quantityWriteGate
      }
      await updateEntry(id, patch)
    }

    const view = render(EntryRow, { props })
    try {
      const quantity = screen.getByLabelText('Quantity') as HTMLInputElement
      quantity.focus()
      await fireEvent.input(quantity, { target: { value: '5' } })

      const unit = screen.getByLabelText('Unit') as HTMLInputElement
      unit.focus()
      await quantityWriteStartedPromise
      expect(quantity.value).toBe('5')

      await updateEntry(entry.id, { notes: 'An external metadata update' })
      const [updatedRow] = await first(repo.watchEntryRows(collection.id, query))
      view.rerender({ ...props, row: updatedRow! })
      expect(quantity.value).toBe('5')

      view.unmount()
      const remounted = render(EntryRow, { props: { ...props, row: updatedRow! } })
      const remountedUnit = screen.getByLabelText('Unit') as HTMLInputElement
      remountedUnit.focus()
      await fireEvent.input(remountedUnit, { target: { value: 'boxes' } })
      remountedUnit.blur()
      releaseQuantityWrite()

      await waitFor(async () => {
        expect(await repo.getEntry(entry.id)).toMatchObject({ quantity: '5', unit: 'boxes' })
      })
      remounted.unmount()
    } finally {
      releaseQuantityWrite()
      repo.updateEntry = updateEntry
    }
  })
})
