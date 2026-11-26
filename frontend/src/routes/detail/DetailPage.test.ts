import { setLocale } from '$lib/paraglide/runtime.js'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Blob as NodeBlob } from 'node:buffer'
import DetailPage from './DetailPage.svelte'
import ToastHost from '../../components/ui/ToastHost.svelte'
import { toasts } from '../../app/toasts.svelte'

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
vi.mock('$lib/sync', () => ({ syncEngine: { status: { subscribe: () => () => {} } } }))
const { repo } = await import('$lib/db')
afterEach(() => {
  cleanup()
  // A leftover Undo toast from an earlier test would otherwise be clicked by the next one.
  toasts.items = []
})

async function first<T>(watch: {
  subscribe: (next: (value: T) => void) => (() => void) | { unsubscribe(): void }
}) {
  // Dexie may emit a cached result synchronously inside subscribe(), before the handle is assigned.
  let result: { value: T } | undefined
  let settle: (value: T) => void = () => {}
  const done = new Promise<T>((resolve) => (settle = resolve))
  const handle = watch.subscribe((value) => {
    if (result) return
    result = { value }
    settle(value)
  })
  const value = await done
  if (typeof handle === 'function') handle()
  else handle.unsubscribe()
  return value
}

async function waitPhotos(entryId: string, predicate: (photos: import('$lib/types').Photo[]) => boolean) {
  // Same synchronous-emission caveat as first().
  let settle: () => void = () => {}
  const done = new Promise<void>((resolve) => (settle = resolve))
  let matched = false
  const handle = repo.watchPhotos(entryId).subscribe((photos) => {
    if (!matched && predicate(photos)) {
      matched = true
      settle()
    }
  })
  await done
  if (typeof handle === 'function') handle()
  else handle.unsubscribe()
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
  it('shows wrapping full-width dimensions and saves a single line', async () => {
    const { entry } = await setup()
    const dimensions = screen.getByLabelText('Dimensions') as HTMLTextAreaElement
    expect(dimensions.tagName).toBe('TEXTAREA')
    expect(dimensions).toHaveAttribute('rows', '2')
    expect(dimensions.closest('label')).toHaveClass('full-field')
    expect(dimensions).toHaveClass('dimensions-field')

    await fireEvent.input(dimensions, { target: { value: 'Outer carton 60 × 40 cm\ninner box 20 × 15 cm' } })
    expect(dimensions.value).toBe('Outer carton 60 × 40 cm inner box 20 × 15 cm')
    const enter = await fireEvent.keyDown(dimensions, { key: 'Enter' })
    expect(enter).toBe(false)
    expect(dimensions.value).not.toContain('\n')
    await fireEvent.blur(dimensions)
    await waitFor(async () =>
      expect((await repo.getEntry(entry.id))?.dimensions).toBe(
        'Outer carton 60 × 40 cm inner box 20 × 15 cm',
      ),
    )
  })

  it('reveals and autosaves collection notes and toggles the entry star', async () => {
    const { collection, entry } = await setup()
    await fireEvent.click(screen.getByRole('button', { name: 'Add note for this collection' }))
    const notes = await screen.findByLabelText(new RegExp(`Notes for ${collection.name}`))
    await fireEvent.input(notes, { target: { value: 'Keep with this room.' } })
    await fireEvent.blur(notes)
    await waitFor(async () =>
      expect((await repo.getEntry(entry.id))?.entry_notes).toBe('Keep with this room.'),
    )
    const star = screen.getByRole('button', { name: 'Star entry' })
    await fireEvent.click(star)
    await waitFor(async () => expect((await repo.getEntry(entry.id))?.starred_at).toEqual(expect.any(String)))
  })

  it('shows shared placements and scope hints, and reports shared photo deletion', async () => {
    const collection = await repo.createCollection({ name: 'Shared target', storage_mode: 'local_only' })
    const entry = await repo.createEntry(collection.id)
    const originalWatch = repo.watchEntry
    const originalDeletePhoto = repo.deletePhoto
    repo.deletePhoto = async () => {}
    repo.watchEntry = ((id) => ({
      subscribe(next: (value: import('$lib/types').EntryView | undefined) => void) {
        const subscription = originalWatch(id).subscribe((value) =>
          next(
            value && {
              ...value,
              shared_with: [
                {
                  collection_id: 'other',
                  collection_name: 'Other room',
                  entry_id: 'other-entry',
                  sequence_number: 9,
                },
              ],
            },
          ),
        )
        return subscription
      },
    })) as typeof repo.watchEntry
    try {
      render(ToastHost)
      render(DetailPage, { props: { collectionId: collection.id, entryId: entry.id } })
      await screen.findByLabelText('Entry title')
      expect(screen.getByText('Also in')).toBeInTheDocument()
      expect(screen.getByRole('link', { name: 'Other room · #0009' })).toHaveAttribute(
        'href',
        '/c/other/e/other-entry',
      )
      expect(screen.getByText('Title, notes and photos are shared across 2 collections.')).toBeInTheDocument()
      expect(screen.getByText('This count is for this collection only.')).toBeInTheDocument()

      await repo.addPhotos(entry.id, [{ blob: new NodeBlob(['shared']) as Blob, source: 'photo_library' }])
      await fireEvent.click(await screen.findByRole('button', { name: 'Delete photo' }))
      expect(await screen.findByText('Photo deleted from 2 collections.')).toBeInTheDocument()
    } finally {
      repo.watchEntry = originalWatch
      repo.deletePhoto = originalDeletePhoto
    }
  })

  it('autosaves edits after the debounce and normalizes decimal commas', async () => {
    const { entry } = await setup()
    await fireEvent.input(screen.getByLabelText('Quantity'), { target: { value: '1,5' } })
    await fireEvent.input(screen.getByLabelText('Entry title'), { target: { value: 'Blue cabinet' } })
    await waitFor(async () => {
      expect((await repo.getEntry(entry.id))?.quantity).toBe('1.5')
      expect((await repo.getEntry(entry.id))?.title).toBe('Blue cabinet')
    })
  })

  it('flushes pending drafts when the document becomes hidden', async () => {
    const { entry } = await setup()
    await fireEvent.input(screen.getByLabelText('Entry title'), { target: { value: 'Saved before camera' } })
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' })
    document.dispatchEvent(new Event('visibilitychange'))
    await waitFor(async () => expect((await repo.getEntry(entry.id))?.title).toBe('Saved before camera'))
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' })
  })

  it('starts flushing pending drafts before opening the native photo picker', async () => {
    const { entry } = await setup()
    await fireEvent.input(screen.getByLabelText('Entry title'), { target: { value: 'Before camera' } })
    await fireEvent.click(screen.getByRole('button', { name: 'Add Photo' }))
    await waitFor(async () => expect((await repo.getEntry(entry.id))?.title).toBe('Before camera'))
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

it('shows a chain and separate arrivals after a return and keeps historical names for cleared rooms', async () => {
  const room = (name: string) => repo.createCollection({ name, storage_mode: 'local_only' })
  const a = await room('Room A')
  const b = await room('Room B')
  const c = await room('Room C')
  const d = await room('Room D')
  const first = await repo.createEntry(a.id, { quantity: '28', unit: 'boxes' })
  const secondLot = (await repo.importEntries(d.id, [first.id])).created[0]!
  await repo.updateEntry(secondLot.id, { quantity: '3' })
  const viaB = (await repo.moveEntries(b.id, [first.id])).created[0]!
  const nowInC = (await repo.moveEntries(c.id, [viaB.id])).created[0]!
  await repo.moveEntries(c.id, [secondLot.id])
  const returned = (await repo.moveEntries(a.id, [nowInC.id])).restored[0]!
  const back = await repo.moveEntryPart(c.id, returned.id, '5')
  await repo.undoMove(back.undo)
  await repo.updateCollection(b.id, { name: 'Room B renamed' })
  await repo.markExported([d.id])
  await repo.clearCollection(d.id, 'Room D')

  render(DetailPage, { props: { collectionId: c.id, entryId: nowInC.id } })
  const history = await screen.findByRole('region', { name: 'History' })
  await waitFor(() => {
    expect([...history.querySelectorAll('li')].map((line) => line.textContent?.replace(/\s+/g, ' '))).toEqual(
      [
        expect.stringContaining('28 boxes from Room A #0001 → Room B renamed #0001'),
        expect.stringContaining('28 boxes from Room B renamed #0001'),
        expect.stringContaining('3 boxes from Room D #0001'),
        expect.stringContaining('→ 31 boxes to Room A #0001'),
      ],
    )
  })
  await fireEvent.click(screen.getByRole('button', { name: 'Show undone' }))
  expect(history.querySelector('li.undone')).toHaveTextContent('5 boxes from Room A #0001')
  await fireEvent.click(screen.getByRole('button', { name: 'Hide undone' }))
  expect(history.querySelector('li.undone')).toBeNull()
})

it('localizes the deleted detail and legacy move notice without changing the stored note', async () => {
  const collection = await repo.createCollection({ name: '仓库甲', storage_mode: 'local_only' })
  const entry = await repo.createEntry(collection.id)
  const legacy = 'Moved to "仓库乙" #0042'
  await repo.updateEntry(entry.id, { entry_notes: legacy })
  await repo.deleteEntry(entry.id)
  await setLocale('zh-CN', { reload: false })
  try {
    render(DetailPage, { props: { collectionId: collection.id, entryId: entry.id } })
    expect(await screen.findByText('已移至“仓库乙”，编号为 #0042')).toBeInTheDocument()
    expect(screen.getByText('已保存到本设备')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '恢复' })).toBeInTheDocument()
    expect(screen.getByText('暂无移动记录')).toBeInTheDocument()
    expect(document.title).toBe('#0001 — 条目详情 — Kufang Capture')
    expect((await repo.getEntry(entry.id))?.entry_notes).toBe(legacy)
  } finally {
    await setLocale('en', { reload: false })
  }
})
