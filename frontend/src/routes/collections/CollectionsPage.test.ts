import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { fakeRepo, navigateSpy } = vi.hoisted(() => ({
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
}))
vi.mock('$lib/db', () => ({ repo: fakeRepo }))
vi.mock('../../app/router.svelte', () => ({ navigate: navigateSpy }))
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
        storage_mode: 'synced',
      }),
    )
    expect(fakeRepo.setSetting).toHaveBeenCalledWith('last_storage_mode', 'synced')
    expect(fakeRepo.requestPersistentStorage).toHaveBeenCalledOnce()
    expect(navigateSpy).toHaveBeenCalledWith('/c/created-room')
  })
})
