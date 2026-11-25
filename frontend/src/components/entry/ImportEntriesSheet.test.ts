import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte'
import { afterEach, describe, expect, it, vi } from 'vitest'

const { repo, showToast } = vi.hoisted(() => ({
  repo: {
    watchImportSources: vi.fn(),
    watchImportCandidates: vi.fn(),
    watchImportSearch: vi.fn(),
    importEntries: vi.fn(),
    deleteEntry: vi.fn(),
  },
  showToast: vi.fn(),
}))
vi.mock('$lib/db', () => ({ repo }))
vi.mock('$lib/photos', () => ({ thumbnailUrl: vi.fn().mockResolvedValue(null) }))
vi.mock('../../app/toasts.svelte', () => ({ showToast }))

import ImportEntriesSheet from './ImportEntriesSheet.svelte'

const source = { id: 'source', name: 'Shelf A', status: 'active' }
const candidate = (id: string, already_here = false) => ({
  entry: {
    id,
    item_id: `item-${id}`,
    sequence_number: 7,
    title: 'Candles',
    quantity: '3',
    unit: 'boxes',
  },
  recent_photos: [],
  already_here,
})
const watch = <T>(value: T) => ({ subscribe: (next: (value: T) => void) => (next(value), () => {}) })

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('ImportEntriesSheet', () => {
  it('shows the empty state when there are no matching collections', async () => {
    repo.watchImportSources.mockReturnValue(watch([]))
    render(ImportEntriesSheet, {
      props: { targetCollectionId: 'target', storageMode: 'local_only', open: true },
    })
    expect(await screen.findByText('No other Local Only collections yet.')).toBeInTheDocument()
    expect(
      screen.getByText('Only Local Only collections can share items with a Local Only collection.'),
    ).toBeInTheDocument()
  })

  it('selects candidates, disables already imported items, imports, and offers undo', async () => {
    repo.watchImportSources.mockReturnValue(
      watch([{ id: 'archived', name: 'Shelf B', status: 'archived' }, source]),
    )
    repo.watchImportCandidates.mockReturnValue(watch([candidate('new'), candidate('present', true)]))
    const created = { id: 'created' }
    const restored = { id: 'restored' }
    repo.importEntries.mockResolvedValue({ created: [created], restored: [restored], skipped: [] })
    repo.deleteEntry.mockResolvedValue(undefined)
    render(ImportEntriesSheet, {
      props: { targetCollectionId: 'target', storageMode: 'local_only', open: true },
    })

    const activeButton = await screen.findByRole('button', { name: 'Shelf A' })
    const archivedButton = screen.getByRole('button', { name: /Shelf B.*Archived/ })
    expect(screen.getByText('Archived')).toBeInTheDocument()
    expect(
      activeButton.compareDocumentPosition(archivedButton) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy()
    await fireEvent.click(activeButton)
    expect(await screen.findByText('Already here')).toBeInTheDocument()
    const boxes = screen.getAllByRole('checkbox')
    expect(boxes[1]).toBeDisabled()
    const importButton = screen.getByRole('button', { name: 'Import 0' })
    expect(importButton).toBeDisabled()
    await fireEvent.click(boxes[0]!)
    await fireEvent.click(screen.getByRole('button', { name: 'Import 1' }))
    await waitFor(() => expect(repo.importEntries).toHaveBeenCalledWith('target', ['new']))
    expect(showToast).toHaveBeenCalledWith(
      expect.objectContaining({
        message: 'Imported 2 · 1 restored with its old number',
        actionLabel: 'Undo',
      }),
    )
    await showToast.mock.calls[0]![0].action()
    expect(repo.deleteEntry).toHaveBeenCalledWith('created')
    expect(repo.deleteEntry).toHaveBeenCalledWith('restored')
  })

  it('keeps selection across global search queries and collection navigation, importing each item once', async () => {
    repo.watchImportSources.mockReturnValue(watch([source]))
    const first = {
      ...candidate('first'),
      entry: { ...candidate('first').entry, item_id: 'same-item' },
      placements: [],
      archived: false,
    }
    const second = {
      ...candidate('second'),
      entry: { ...candidate('second').entry, item_id: 'another-item', title: 'Incense' },
      placements: [],
      archived: false,
    }
    const many = Array.from({ length: 49 }, (_, index) => ({
      ...candidate(`extra-${index}`),
      entry: { ...candidate(`extra-${index}`).entry, item_id: `extra-item-${index}` },
      placements: [],
      archived: false,
    }))
    repo.watchImportSearch.mockImplementation((_target: string, query: string) =>
      watch(query === 'lamp' ? [first] : [first, second, ...many]),
    )
    repo.watchImportCandidates.mockReturnValue(watch([candidate('other')]))
    repo.importEntries.mockResolvedValue({ created: [], restored: [], skipped: [] })
    render(ImportEntriesSheet, {
      props: { targetCollectionId: 'target', storageMode: 'local_only', open: true },
    })
    const input = await screen.findByRole('textbox', { name: 'Search all collections' })
    await fireEvent.input(input, { target: { value: 'lamp' } })
    await waitFor(() => expect(repo.watchImportSearch).toHaveBeenCalledWith('target', 'lamp'))
    await screen.findByText('Candles')
    await fireEvent.click(screen.getByRole('checkbox'))
    await fireEvent.input(input, { target: { value: 'candles' } })
    await waitFor(() => expect(repo.watchImportSearch).toHaveBeenCalledWith('target', 'candles'))
    await fireEvent.click(screen.getByText('Incense'))
    await fireEvent.click(screen.getByRole('button', { name: 'Show more' }))
    expect(screen.getAllByRole('checkbox')).toHaveLength(51)
    await fireEvent.input(input, { target: { value: '' } })
    await fireEvent.click(screen.getByRole('button', { name: 'Shelf A' }))
    await screen.findByText('Search items')
    await fireEvent.click(screen.getByRole('button', { name: /Back/ }))
    expect(screen.getByText('2 selected')).toBeInTheDocument()
    await fireEvent.click(screen.getByRole('button', { name: 'Import 2' }))
    await waitFor(() => expect(repo.importEntries).toHaveBeenCalledWith('target', ['first', 'second']))
  })
})
