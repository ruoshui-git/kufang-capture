import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte'
import { afterEach, describe, expect, it, vi } from 'vitest'

const { repo, showToast } = vi.hoisted(() => ({
  repo: {
    watchCollectionSummaries: vi.fn(),
    getSetting: vi.fn(),
    setSetting: vi.fn(),
    getEntry: vi.fn(),
    moveEntries: vi.fn(),
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
})
