import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte'
import { afterEach, describe, expect, it, vi } from 'vitest'

const { repo, showToast } = vi.hoisted(() => ({ repo: { mergeCollections: vi.fn() }, showToast: vi.fn() }))
vi.mock('$lib/db', () => ({ repo }))
vi.mock('../../app/toasts.svelte', () => ({ showToast }))
import MergeCollectionsSheet from './MergeCollectionsSheet.svelte'

const collection = (id: string, name: string, created_at: string, storage_mode = 'local_only') =>
  ({
    collection: { id, name, created_at, storage_mode },
    entry_count: 3,
  }) as never
afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('MergeCollectionsSheet', () => {
  it('defaults to the oldest target, blocks different storage modes, and merges selected sources', async () => {
    repo.mergeCollections.mockResolvedValue({ created: [], restored: [], merged_into_existing: [] })
    render(MergeCollectionsSheet, {
      props: {
        selected: [collection('new', 'Room B', '2026-02'), collection('old', 'Room A', '2026-01')],
        open: true,
      },
    })
    expect(screen.getByRole('radio', { name: /Room A/ })).toBeChecked()
    expect(screen.getByText('3 entries from Room B move into Room A.')).toBeInTheDocument()
    await fireEvent.click(screen.getByRole('button', { name: 'Merge collections' }))
    await waitFor(() => expect(repo.mergeCollections).toHaveBeenCalledWith('old', ['new']))
    expect(showToast).toHaveBeenCalledWith({
      message: 'Merged 2 collections into "Room A". The others are archived.',
    })

    cleanup()
    render(MergeCollectionsSheet, {
      props: { selected: [collection('a', 'A', '1'), collection('b', 'B', '2', 'synced')], open: true },
    })
    expect(screen.getByRole('alert')).toHaveTextContent('Collections must use the same storage mode.')
    expect(screen.getByRole('button', { name: 'Merge collections' })).toBeDisabled()
  })
})
