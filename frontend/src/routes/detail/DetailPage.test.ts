import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Blob as NodeBlob } from 'node:buffer'
import DetailPage from './DetailPage.svelte'
import ToastHost from '../../components/ui/ToastHost.svelte'

vi.mock('$lib/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('$lib/db')>()
  return {
    repo: actual.createRepo({
      databaseName: `detail-component-${Date.now()}`,
      imageProcessor: async () => {
        throw new Error('thumbnail unavailable')
      },
    }),
  }
})
vi.mock('$lib/camera', () => ({ pickPhotos: vi.fn(() => Promise.resolve([])) }))
const { repo } = await import('$lib/db')
afterEach(cleanup)

async function first<T>(watch: {
  subscribe: (next: (value: T) => void) => (() => void) | { unsubscribe(): void }
}) {
  return new Promise<T>((resolve) => {
    const unsubscribe = watch.subscribe((value) => {
      if (typeof unsubscribe === 'function') unsubscribe()
      else unsubscribe.unsubscribe()
      resolve(value)
    })
  })
}

async function waitPhotos(entryId: string, predicate: (photos: import('$lib/types').Photo[]) => boolean) {
  await new Promise<void>((resolve) => {
    const subscription = repo.watchPhotos(entryId).subscribe((photos) => {
      if (predicate(photos)) {
        if (typeof subscription === 'function') subscription()
        else subscription.unsubscribe()
        resolve()
      }
    })
  })
  return first(repo.watchPhotos(entryId))
}

async function setup() {
  const collection = await repo.createCollection({ name: 'Detail room', storage_mode: 'local_only' })
  const entry = await repo.createEntry(collection.id)
  render(ToastHost)
  render(DetailPage, { props: { collectionId: collection.id, entryId: entry.id } })
  await screen.findByLabelText('Entry title')
  return { collection, entry }
}

describe('entry detail', () => {
  it('autosaves edits after the debounce and normalizes decimal commas', async () => {
    const { entry } = await setup()
    await fireEvent.input(screen.getByLabelText('Quantity'), { target: { value: '1,5' } })
    await fireEvent.input(screen.getByLabelText('Entry title'), { target: { value: 'Blue cabinet' } })
    await waitFor(async () => {
      expect((await repo.getEntry(entry.id))?.quantity).toBe('1.5')
      expect((await repo.getEntry(entry.id))?.title).toBe('Blue cabinet')
    })
  })

  it('does not write invalid quantities and keeps exactly one cover when changed', async () => {
    const { entry } = await setup()
    await fireEvent.input(screen.getByLabelText('Quantity'), { target: { value: '12 boxes' } })
    await new Promise((resolve) => setTimeout(resolve, 350))
    expect((await repo.getEntry(entry.id))?.quantity).toBeNull()
    expect(screen.getByRole('alert').textContent).toContain('decimal number')

    const [firstPhoto] = await repo.addPhotos(entry.id, [
      { blob: new NodeBlob(['first']) as Blob, source: 'photo_library' },
    ])
    const [secondPhoto] = await repo.addPhotos(entry.id, [
      { blob: new NodeBlob(['second']) as Blob, source: 'photo_library' },
    ])
    await fireEvent.click(await screen.findByRole('button', { name: 'Set as cover' }))
    const current = await waitPhotos(
      entry.id,
      (items) => items.find((photo) => photo.id === secondPhoto!.id)?.is_cover === true,
    )
    expect(current.filter((photo) => photo.is_cover)).toHaveLength(1)
    expect(current.find((photo) => photo.id === secondPhoto!.id)?.is_cover).toBe(true)
    expect(firstPhoto).toBeDefined()
  })

  it('reorders photos and restores a deleted photo from Undo', async () => {
    const { entry } = await setup()
    const [firstPhoto] = await repo.addPhotos(entry.id, [
      { blob: new NodeBlob(['one']) as Blob, source: 'photo_library' },
    ])
    const [secondPhoto] = await repo.addPhotos(entry.id, [
      { blob: new NodeBlob(['two']) as Blob, source: 'photo_library' },
    ])
    await waitFor(() => expect(screen.getAllByRole('button', { name: 'Delete photo' })).toHaveLength(2))
    await fireEvent.click(screen.getAllByRole('button', { name: 'Move later' })[0]!)
    const ordered = await waitPhotos(entry.id, (items) => items[0]?.id === secondPhoto!.id)
    expect(ordered.map((photo) => photo.id)).toEqual([secondPhoto!.id, firstPhoto!.id])
    await fireEvent.click(screen.getAllByRole('button', { name: 'Delete photo' })[0]!)
    await fireEvent.click(await screen.findByRole('button', { name: 'Undo' }))
    const restored = await waitPhotos(
      entry.id,
      (items) => items.filter((photo) => !photo.deleted_at).length === 2,
    )
    expect(restored.filter((photo) => !photo.deleted_at)).toHaveLength(2)
  })

  it('shows previous and next entries in repository sort order', async () => {
    const collection = await repo.createCollection({ name: 'Navigation', storage_mode: 'local_only' })
    const one = await repo.createEntry(collection.id)
    const two = await repo.createEntry(collection.id)
    const three = await repo.createEntry(collection.id)
    render(DetailPage, { props: { collectionId: collection.id, entryId: two.id } })
    await screen.findByLabelText('Entry title')
    await waitFor(() => expect(screen.getByRole('button', { name: 'Previous' })).not.toBeDisabled())
    expect(await repo.getAdjacentEntryIds(two.id, 'newest')).toEqual({ prev: three.id, next: one.id })
  })
})
