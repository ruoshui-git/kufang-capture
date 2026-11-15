import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { fakeRepo, navigateSpy, exportFromDevice } = vi.hoisted(() => ({
  fakeRepo: {
    watchCollectionSummaries: vi.fn(),
    getSetting: vi.fn(),
    createCollection: vi.fn(),
    updateCollection: vi.fn(),
    setSetting: vi.fn(),
    requestPersistentStorage: vi.fn(),
    archiveCollection: vi.fn(),
    unarchiveCollection: vi.fn(),
  },
  navigateSpy: vi.fn(),
  exportFromDevice: vi.fn(),
}))
vi.mock('$lib/db', () => ({ repo: fakeRepo }))
vi.mock('../../app/router.svelte', () => ({ navigate: navigateSpy }))
vi.mock('$lib/export/device', () => ({ exportFromDevice }))
import CollectionsPage from './CollectionsPage.svelte'

const sample = {
  collection: {
    id: 'room-one',
    name: 'Temple 2 / A04',
    description: '',
    status: 'active',
    storage_mode: 'local_only',
    updated_at: '2026-11-08T00:00:00.000Z',
  },
  entry_count: 2,
  photo_count: 3,
  incomplete_count: 1,
  last_activity_at: '2026-11-08T00:00:00.000Z',
  quantity_by_unit: [
    { unit: 'boxes', total: '5' },
    { unit: 'pieces', total: '12' },
  ],
} as never

afterEach(() => cleanup())
beforeEach(() => {
  vi.clearAllMocks()
  exportFromDevice.mockResolvedValue({ delivery: 'download', filename: 'export.zip', byteSize: 1 })
  fakeRepo.watchCollectionSummaries.mockReturnValue({
    subscribe: (next: (value: unknown[]) => void) => {
      next([sample])
      return () => {}
    },
  })
  fakeRepo.getSetting.mockResolvedValue('local_only')
  fakeRepo.createCollection.mockResolvedValue({ id: 'created-room' })
  fakeRepo.setSetting.mockResolvedValue(undefined)
  fakeRepo.requestPersistentStorage.mockResolvedValue(true)
})

describe('Collections page', () => {
  it('shows collection and entry totals without any global quantity', () => {
    render(CollectionsPage)
    expect(screen.getByText('1 collection')).toBeInTheDocument()
    expect(screen.getAllByText('2 entries')).toHaveLength(2)
    expect(screen.getAllByText('2 entries').some((element) => element.classList.contains('stat-chip'))).toBe(
      true,
    )
    expect(screen.getByText('3 photos')).toHaveClass('stat-chip')
    expect(screen.getByText('1 incomplete')).toHaveClass('incomplete')
    expect(screen.getByRole('button', { name: 'New collection' })).toHaveTextContent('+ New')
    expect(screen.queryByText(/17/)).not.toBeInTheDocument()
  })
  it('creates a collection with the selected storage mode and navigates to it', async () => {
    render(CollectionsPage)
    await fireEvent.click(screen.getByRole('button', { name: 'New collection' }))
    expect(screen.getByText('Enter a name to continue.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Create collection' })).toBeDisabled()
    await fireEvent.input(screen.getByLabelText('Name'), { target: { value: 'New room' } })
    await fireEvent.click(screen.getByLabelText(/Sync to Server/))
    await fireEvent.click(screen.getByRole('button', { name: 'Create collection' }))
    await waitFor(() =>
      expect(fakeRepo.createCollection).toHaveBeenCalledWith({
        name: 'New room',
        description: '',
        folder: '',
        storage_mode: 'synced',
      }),
    )
    expect(fakeRepo.setSetting).toHaveBeenCalledWith('last_storage_mode', 'synced')
    expect(fakeRepo.requestPersistentStorage).toHaveBeenCalledOnce()
    expect(navigateSpy).toHaveBeenCalledWith('/c/created-room')
  })
  it('groups folders alphabetically and persists collapsed folder state', async () => {
    const base = sample as unknown as Record<string, unknown>
    const collection = base.collection as Record<string, unknown>
    const north = { ...base, collection: { ...collection, folder: 'North' } }
    const archive = {
      ...base,
      collection: { ...collection, id: 'room-two', name: 'A03', folder: 'Archive' },
    }
    fakeRepo.getSetting.mockResolvedValueOnce([])
    fakeRepo.watchCollectionSummaries.mockReturnValue({
      subscribe: (next: (value: unknown[]) => void) => {
        next([north, archive])
        return () => {}
      },
    })
    render(CollectionsPage)
    const headings = screen
      .getAllByRole('button')
      .filter((button) => /Archive|North/.test(button.textContent ?? ''))
    expect(headings[0]).toHaveTextContent('Archive')
    expect(headings[1]).toHaveTextContent('North')
    expect(document.querySelectorAll('.collection-open')).toHaveLength(2)
    await fireEvent.click(headings[1]!)
    expect(fakeRepo.setSetting).toHaveBeenCalledWith('collapsed_folders', ['North'])
    await waitFor(() => expect(document.querySelectorAll('.collection-open')).toHaveLength(1))
  })

  it('labels unfiled collections only when folders exist', async () => {
    const base = sample as unknown as Record<string, unknown>
    const collection = base.collection as Record<string, unknown>
    const filed = { ...base, collection: { ...collection, id: 'filed', name: 'Filed', folder: 'North' } }
    const loose = { ...base, collection: { ...collection, id: 'loose', name: 'Loose', folder: '' } }
    fakeRepo.getSetting.mockResolvedValueOnce([])
    fakeRepo.watchCollectionSummaries.mockReturnValue({
      subscribe: (next: (value: unknown[]) => void) => {
        next([filed, loose])
        return () => {}
      },
    })
    render(CollectionsPage)
    expect(screen.getByRole('heading', { name: /Not in a folder/ })).toHaveTextContent('1')
  })

  it('shows no unfiled label when no collection is in a folder', () => {
    render(CollectionsPage)
    expect(screen.queryByRole('heading', { name: /Not in a folder/ })).not.toBeInTheDocument()
  })

  it('enters and leaves selection mode and toggles a collection card', async () => {
    render(CollectionsPage)
    await fireEvent.click(screen.getByRole('button', { name: 'Select' }))
    expect(screen.getByRole('region', { name: 'Export selected collections' })).toHaveTextContent(
      '0 selected',
    )
    expect(screen.getByRole('button', { name: 'Export ZIP' })).toBeDisabled()
    expect(screen.queryByRole('link', { name: 'Open Temple 2 / A04' })).not.toBeInTheDocument()
    await fireEvent.click(screen.getByRole('checkbox', { name: 'Temple 2 / A04' }))
    expect(screen.getByRole('region', { name: 'Export selected collections' })).toHaveTextContent(
      '1 selected',
    )
    await fireEvent.click(screen.getByRole('button', { name: /^Cancel$/ }))
    expect(screen.queryByRole('region', { name: 'Export selected collections' })).not.toBeInTheDocument()
  })

  it('selects and clears all collections in a folder and exports selected ids in display order', async () => {
    const base = sample as unknown as Record<string, unknown>
    const collection = base.collection as Record<string, unknown>
    const northA = { ...base, collection: { ...collection, id: 'north-a', name: 'North A', folder: 'North' } }
    const south = { ...base, collection: { ...collection, id: 'south', name: 'South', folder: 'South' } }
    const northB = { ...base, collection: { ...collection, id: 'north-b', name: 'North B', folder: 'North' } }
    fakeRepo.getSetting.mockResolvedValueOnce([])
    fakeRepo.watchCollectionSummaries.mockReturnValue({
      subscribe: (next: (value: unknown[]) => void) => {
        next([south, northB, northA])
        return () => {}
      },
    })
    render(CollectionsPage)
    await fireEvent.click(screen.getByRole('button', { name: 'Select' }))
    await fireEvent.click(screen.getAllByRole('button', { name: 'Select all' })[0]!)
    expect(screen.getByRole('region', { name: 'Export selected collections' })).toHaveTextContent(
      '2 selected',
    )
    await fireEvent.click(screen.getByRole('button', { name: 'Export ZIP' }))
    expect(screen.getByRole('dialog', { name: 'Export 2 collections' })).toBeInTheDocument()
    expect(screen.getByText(/from 2 collections/)).toBeInTheDocument()
    await fireEvent.click(screen.getAllByRole('button', { name: 'Export ZIP' }).at(-1)!)
    await waitFor(() =>
      expect(exportFromDevice).toHaveBeenCalledWith(['north-b', 'north-a'], expect.anything()),
    )
    await fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    await fireEvent.click(screen.getByRole('button', { name: 'Clear' }))
    expect(screen.getByRole('region', { name: 'Export selected collections' })).toHaveTextContent(
      '0 selected',
    )
  })

  it('leaves selection mode on Escape', async () => {
    render(CollectionsPage)
    await fireEvent.click(screen.getByRole('button', { name: 'Select' }))
    await fireEvent.keyDown(window, { key: 'Escape' })
    expect(screen.queryByRole('region', { name: 'Export selected collections' })).not.toBeInTheDocument()
  })
})
