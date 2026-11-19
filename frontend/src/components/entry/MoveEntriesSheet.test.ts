import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte'
import { afterEach, describe, expect, it, vi } from 'vitest'

const { repo, showToast } = vi.hoisted(() => ({
  repo: {
    watchEntryRows: vi.fn(),
    watchCollectionSummaries: vi.fn(),
    splitEntries: vi.fn(),
    moveEntries: vi.fn(),
  },
  showToast: vi.fn(),
}))
vi.mock('$lib/db', () => ({ repo }))
vi.mock('../../app/toasts.svelte', () => ({ showToast }))
import MoveEntriesSheet from './MoveEntriesSheet.svelte'

const watch = <T>(value: T) => ({ subscribe: (next: (item: T) => void) => (next(value), () => {}) })
const row = (id: string, sequence_number: number, title: string) => ({
  entry: {
    id,
    sequence_number,
    title,
    notes: '',
    entry_notes: '',
    quantity: null,
    unit: '',
    count_detail: '',
  },
})
const room = (id: string, name: string) => ({
  collection: { id, name, storage_mode: 'local_only' },
  entry_count: 1,
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('MoveEntriesSheet', () => {
  it('selects active entries and splits them into a named collection', async () => {
    repo.watchEntryRows.mockReturnValue(watch([row('entry-1', 1, 'Candles'), row('entry-2', 2, 'Incense')]))
    repo.watchCollectionSummaries.mockReturnValue(watch([room('source', 'Room A'), room('other', 'Room B')]))
    repo.splitEntries.mockResolvedValue({
      collection: {},
      result: { created: [{}], restored: [], merged_into_existing: [] },
    })
    render(MoveEntriesSheet, {
      props: {
        collectionId: 'source',
        sourceName: 'Room A',
        folder: 'North',
        storageMode: 'local_only',
        open: true,
      },
    })
    expect(screen.getByLabelText('New collection name')).toHaveValue('Room A (split)')
    expect(screen.getByLabelText('New collection folder')).toHaveValue('North')
    await fireEvent.click(screen.getByRole('checkbox', { name: /Candles/ }))
    await fireEvent.click(screen.getByRole('button', { name: 'Move 1' }))
    await waitFor(() =>
      expect(repo.splitEntries).toHaveBeenCalledWith(['entry-1'], {
        name: 'Room A (split)',
        folder: 'North',
      }),
    )
    expect(showToast).toHaveBeenCalledWith({ message: 'Moved 1 entry' })
  })

  it('moves selected entries to an existing same-mode collection and filters entries', async () => {
    repo.watchEntryRows.mockReturnValue(watch([row('entry-1', 1, 'Candles'), row('entry-2', 2, 'Incense')]))
    repo.watchCollectionSummaries.mockReturnValue(watch([room('source', 'Room A'), room('other', 'Room B')]))
    repo.moveEntries.mockResolvedValue({ created: [{}], restored: [], merged_into_existing: [] })
    render(MoveEntriesSheet, {
      props: {
        collectionId: 'source',
        sourceName: 'Room A',
        folder: '',
        storageMode: 'local_only',
        open: true,
      },
    })
    await fireEvent.input(screen.getByLabelText('Search move entries'), { target: { value: 'Incense' } })
    expect(screen.queryByText('Candles')).not.toBeInTheDocument()
    await fireEvent.click(screen.getByRole('checkbox', { name: /Incense/ }))
    await fireEvent.click(screen.getByRole('radio', { name: 'Room B' }))
    await fireEvent.click(screen.getByRole('button', { name: 'Move 1' }))
    await waitFor(() => expect(repo.moveEntries).toHaveBeenCalledWith('other', ['entry-2']))
  })
})
