import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRepo } from '$lib/db'

const { shared } = vi.hoisted(() => ({
  shared: { repo: null as unknown, navigate: vi.fn(), pickPhotos: vi.fn() },
}))
vi.mock('$lib/db', async () => {
  const actual = await vi.importActual<typeof import('$lib/db')>('$lib/db')
  return {
    ...actual,
    get repo() {
      return shared.repo
    },
  }
})
vi.mock('../../app/router.svelte', () => ({
  navigate: shared.navigate,
  saveScroll: vi.fn(),
  restoreScroll: vi.fn(),
}))
vi.mock('$lib/camera', () => ({ pickPhotos: shared.pickPhotos }))
vi.mock('$lib/photos', async () => {
  const actual = await vi.importActual<typeof import('$lib/photos')>('$lib/photos')
  return { ...actual, thumbnailUrl: vi.fn().mockResolvedValue(null) }
})
import EntryListPage from './EntryListPage.svelte'
import { toasts } from '../../app/toasts.svelte'

let repo: ReturnType<typeof createRepo>
let collectionId = ''
let dbCounter = 0

beforeEach(async () => {
  vi.clearAllMocks()
  toasts.items = []
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: () => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }),
  })
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: vi.fn() })
  Object.defineProperty(globalThis, 'IntersectionObserver', {
    configurable: true,
    value: class {
      observe() {}
      disconnect() {}
    },
  })
  repo = createRepo({
    databaseName: `entry-list-test-${++dbCounter}`,
    imageProcessor: async () => ({ width: 1, height: 1, thumbnail: new Blob(['thumb']) }),
  })
  shared.repo = repo
  const collection = await repo.createCollection({ name: 'Test room', storage_mode: 'local_only' })
  collectionId = collection.id
  shared.pickPhotos.mockResolvedValue([])
})

afterEach(() => cleanup())

describe('Entry list', () => {
  it('creates the next numbered row and focuses its title without navigating', async () => {
    render(EntryListPage, { props: { collectionId } })
    await fireEvent.click(screen.getAllByRole('button', { name: /New Entry/ })[0]!)
    const title = await screen.findByRole('textbox', { name: 'Entry title' })
    await waitFor(() => expect(title).toHaveFocus())
    expect(title).toHaveAttribute('placeholder', 'Entry #0001')
    expect(shared.navigate).not.toHaveBeenCalled()
  })

  it('keeps a focused draft through a live update and persists it after debounce', async () => {
    const entry = await repo.createEntry(collectionId)
    render(EntryListPage, { props: { collectionId } })
    const title = await screen.findByRole('textbox', { name: 'Entry title' })
    title.focus()
    await fireEvent.input(title, { target: { value: 'My draft' } })
    await repo.updateEntry(entry.id, { notes: 'external edit' })
    expect(title).toHaveValue('My draft')
    expect(title).toHaveFocus()
    await waitFor(async () => expect((await repo.getEntry(entry.id))?.title).toBe('My draft'), {
      timeout: 1200,
    })
  })

  it('does not save invalid quantity text', async () => {
    const entry = await repo.createEntry(collectionId)
    render(EntryListPage, { props: { collectionId } })
    const quantity = await screen.findByRole('textbox', { name: 'Quantity' })
    await fireEvent.input(quantity, { target: { value: '12 boxes' } })
    expect(await screen.findByText('Enter a number such as 12 or 12.5.')).toBeInTheDocument()
    await new Promise((resolve) => setTimeout(resolve, 400))
    expect((await repo.getEntry(entry.id))?.quantity).toBeNull()
    expect(quantity).toHaveValue('12 boxes')
  })

  it('filters incomplete rows and searches immutable sequence numbers', async () => {
    await repo.createEntry(collectionId)
    await repo.createEntry(collectionId)
    await repo.createEntry(collectionId)
    render(EntryListPage, { props: { collectionId } })
    await screen.findAllByRole('textbox', { name: 'Entry title' })
    await fireEvent.click(screen.getByRole('button', { name: 'Incomplete' }))
    await waitFor(() => expect(screen.getAllByRole('textbox', { name: 'Entry title' })).toHaveLength(3))
    await fireEvent.input(screen.getByRole('textbox', { name: 'Search entries' }), {
      target: { value: '#0003' },
    })
    await waitFor(() => expect(screen.getAllByRole('textbox', { name: 'Entry title' })).toHaveLength(1))
    expect(screen.getByRole('textbox', { name: 'Entry title' })).toHaveAttribute('placeholder', 'Entry #0003')
  })

  it('shows separate quantity chips for each unit', async () => {
    const boxes = await repo.createEntry(collectionId, { quantity: '5', unit: 'boxes' })
    const pieces = await repo.createEntry(collectionId, { quantity: '12', unit: 'pieces' })
    await repo.updateEntry(boxes.id, { title: 'Boxes' })
    await repo.updateEntry(pieces.id, { title: 'Pieces' })
    render(EntryListPage, { props: { collectionId } })
    expect(await screen.findByText('5 boxes')).toBeInTheDocument()
    expect(screen.getByText('12 pieces')).toBeInTheDocument()
    expect(screen.queryByText('17')).not.toBeInTheDocument()
  })

  it('deletes an entry and Undo restores its original sequence number', async () => {
    const entry = await repo.createEntry(collectionId)
    render(EntryListPage, { props: { collectionId } })
    await screen.findByRole('textbox', { name: 'Entry title' })
    await fireEvent.click(screen.getByRole('menuitem', { name: 'Delete entry' }))
    await waitFor(() =>
      expect(screen.queryByRole('textbox', { name: 'Entry title' })).not.toBeInTheDocument(),
    )
    const undo = toasts.items.at(-1)?.action
    expect(undo).toBeDefined()
    undo?.()
    await waitFor(() => expect(screen.getByRole('textbox', { name: 'Entry title' })).toBeInTheDocument())
    expect((await repo.getEntry(entry.id))?.sequence_number).toBe(1)
  })

  it('reports when deleting a shared entry leaves it in another collection', async () => {
    const source = await repo.createCollection({ name: 'Source room', storage_mode: 'local_only' })
    const sourceEntry = await repo.createEntry(source.id)
    await repo.importEntries(collectionId, [sourceEntry.id])
    render(EntryListPage, { props: { collectionId } })
    await screen.findByRole('textbox', { name: 'Entry title' })
    await fireEvent.click(screen.getByRole('menuitem', { name: 'Delete entry' }))
    await waitFor(() =>
      expect(toasts.items.at(-1)?.message).toBe('Removed from Test room. Still in Source room.'),
    )
    toasts.items.at(-1)?.action?.()
    await waitFor(() => expect(screen.getByRole('textbox', { name: 'Entry title' })).toBeInTheDocument())
  })

  it('adds a photo to its row without navigating', async () => {
    const entry = await repo.createEntry(collectionId)
    shared.pickPhotos.mockResolvedValue([
      {
        blob: new Blob(['camera bytes'], { type: 'image/jpeg' }),
        filename: 'capture.jpg',
        source: 'native_camera',
      },
    ])
    render(EntryListPage, { props: { collectionId } })
    await screen.findByRole('textbox', { name: 'Entry title' })
    await fireEvent.click(screen.getByRole('button', { name: /Add Photo/ }))
    await waitFor(() => expect(screen.getByText('1 photo')).toBeInTheDocument())
    expect(shared.pickPhotos).toHaveBeenCalledWith('camera')
    // The header chip can update before the row; wait for the row's own thumbnail.
    await fireEvent.click(await screen.findByRole('button', { name: 'Open photo' }))
    expect(screen.getByRole('dialog', { name: 'Photo viewer' })).toBeInTheDocument()
    expect(shared.navigate).not.toHaveBeenCalled()
  })

  it('restores a deleted entry from Recently Deleted with its sequence number', async () => {
    const entry = await repo.createEntry(collectionId)
    await repo.deleteEntry(entry.id)
    render(EntryListPage, { props: { collectionId } })
    await fireEvent.click(screen.getByRole('button', { name: 'Recently Deleted' }))
    await fireEvent.click(await screen.findByRole('button', { name: 'Restore' }))
    await waitFor(async () => expect((await repo.getEntry(entry.id))?.deleted_at).toBeNull())
    expect((await repo.getEntry(entry.id))?.sequence_number).toBe(1)
  })
})
