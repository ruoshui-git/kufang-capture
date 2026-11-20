import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte'
import { afterEach, describe, expect, it, vi } from 'vitest'

const { repo, showToast } = vi.hoisted(() => ({
  repo: {
    watchCollectionSummaries: vi.fn(),
    getSetting: vi.fn(),
    setSetting: vi.fn(),
    getEntry: vi.fn(),
    moveEntries: vi.fn(),
    moveEntryPart: vi.fn(),
    undoMove: vi.fn(),
  },
  showToast: vi.fn(),
}))
vi.mock('$lib/db', () => ({ repo }))
vi.mock('../../app/toasts.svelte', () => ({ showToast }))
import MoveToSheet from './MoveToSheet.svelte'

const watch = <T>(value: T) => ({ subscribe: (next: (item: T) => void) => (next(value), () => {}) })
const room = (id: string, name: string) => ({
  collection: { id, name, folder: '', status: 'active', storage_mode: 'local_only' },
  entry_count: 0,
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('MoveToSheet', () => {
  it('saves pending edits before moving the entry', async () => {
    const calls: string[] = []
    repo.watchCollectionSummaries.mockReturnValue(watch([room('a', 'Room A'), room('b', 'Room B')]))
    repo.getSetting.mockResolvedValue([])
    repo.getEntry.mockResolvedValue({
      id: 'e1',
      collection_id: 'a',
      sequence_number: 12,
      title: '',
      deleted_at: null,
    })
    repo.moveEntries.mockImplementation(async () => {
      calls.push('move')
      return { created: [{ id: 'e2', sequence_number: 1 }], restored: [], merged_into_existing: [], undo: {} }
    })
    const beforemove = vi.fn(async () => {
      calls.push('flush')
    })
    render(MoveToSheet, { open: true, entryId: 'e1', beforemove })
    await fireEvent.click(await screen.findByRole('button', { name: /Room B/ }))
    await waitFor(() => expect(repo.moveEntries).toHaveBeenCalledWith('b', ['e1']))
    expect(calls).toEqual(['flush', 'move'])
  })

  it('moves a normalized partial amount and reports the partial move', async () => {
    repo.watchCollectionSummaries.mockReturnValue(watch([room('a', 'Room A'), room('b', 'Room B')]))
    repo.getSetting.mockResolvedValue([])
    repo.getEntry.mockResolvedValue({
      id: 'e1',
      collection_id: 'a',
      sequence_number: 12,
      quantity: '12',
      unit: 'boxes',
      deleted_at: null,
    })
    repo.moveEntryPart.mockResolvedValue({
      created: [{ id: 'e2', sequence_number: 43 }],
      restored: [],
      merged_into_existing: [],
      undo: {},
    })
    const onmoved = vi.fn()
    render(MoveToSheet, { open: true, entryId: 'e1', onmoved })
    const amount = await screen.findByRole('textbox', { name: 'Amount to move' })
    expect(amount).toHaveValue('12')
    expect(screen.getByText('of 12 boxes')).toBeTruthy()
    await fireEvent.input(amount, { target: { value: ' 5,0 ' } })
    await fireEvent.click(screen.getByRole('button', { name: /Room B/ }))
    await waitFor(() => expect(repo.moveEntryPart).toHaveBeenCalledWith('b', 'e1', '5.0'))
    expect(onmoved).toHaveBeenCalledWith({ partial: true })
    expect(showToast).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'Moved 5.0 boxes to "Room B" as #0043' }),
    )
  })

  it('blocks invalid amounts and uses the ordinary move path for the whole amount', async () => {
    repo.watchCollectionSummaries.mockReturnValue(watch([room('a', 'Room A'), room('b', 'Room B')]))
    repo.getSetting.mockResolvedValue([])
    repo.getEntry.mockResolvedValue({
      id: 'e1',
      collection_id: 'a',
      sequence_number: 12,
      quantity: '12',
      unit: 'boxes',
      deleted_at: null,
    })
    repo.moveEntries.mockResolvedValue({
      created: [{ id: 'e2', sequence_number: 43 }],
      restored: [],
      merged_into_existing: [],
      undo: {},
    })
    render(MoveToSheet, { open: true, entryId: 'e1' })
    const amount = await screen.findByRole('textbox', { name: 'Amount to move' })
    await fireEvent.input(amount, { target: { value: '13' } })
    expect(screen.getByRole('alert').textContent).toContain('cannot exceed')
    expect(screen.getByRole('button', { name: /Room B/ })).toBeDisabled()
    await fireEvent.input(amount, { target: { value: '12' } })
    await fireEvent.click(screen.getByRole('button', { name: /Room B/ }))
    await waitFor(() => expect(repo.moveEntries).toHaveBeenCalledWith('b', ['e1']))
    expect(repo.moveEntryPart).not.toHaveBeenCalled()
  })

  it('does not watch collections until it is opened', async () => {
    const unsubscribe = vi.fn()
    repo.watchCollectionSummaries.mockReturnValue({ subscribe: () => unsubscribe })
    repo.getSetting.mockResolvedValue([])
    repo.getEntry.mockResolvedValue(undefined)
    const view = render(MoveToSheet, { open: false, entryId: 'e1' })
    expect(repo.watchCollectionSummaries).not.toHaveBeenCalled()
    await view.rerender({ open: true })
    expect(repo.watchCollectionSummaries).toHaveBeenCalledTimes(1)
    await view.rerender({ open: false })
    expect(unsubscribe).toHaveBeenCalledTimes(1)
  })
})
