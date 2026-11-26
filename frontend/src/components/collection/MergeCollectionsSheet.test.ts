import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte'
import { afterEach, describe, expect, it, vi } from 'vitest'

const { repo, showToast } = vi.hoisted(() => ({ repo: { mergeCollections: vi.fn() }, showToast: vi.fn() }))
vi.mock('$lib/db', () => ({ repo }))
vi.mock('../../app/toasts.svelte', () => ({ showToast }))
import MergeCollectionsSheet from './MergeCollectionsSheet.svelte'
import { m } from '$lib/paraglide/messages.js'
import { setLocale } from '$lib/paraglide/runtime.js'

const collection = (id: string, name: string, created_at: string, storage_mode = 'local_only') =>
  ({
    collection: { id, name, created_at, storage_mode },
    entry_count: 3,
  }) as never
afterEach(async () => {
  cleanup()
  vi.clearAllMocks()
  await setLocale('en', { reload: false })
})

describe('MergeCollectionsSheet', () => {
  it('renders the localized repository error and keeps the selection open', async () => {
    await setLocale('zh-CN', { reload: false })
    repo.mergeCollections.mockRejectedValueOnce(new Error(m.core_source_collections_invalid()))
    render(MergeCollectionsSheet, {
      props: { selected: [collection('a', 'Room A', '1'), collection('b', 'Room B', '2')], open: true },
    })
    expect(screen.getByText('将“Room B”中的 3 个条目移至“Room A”。')).toBeInTheDocument()
    await fireEvent.click(screen.getByRole('button', { name: '合并清点单' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('来源清点单必须存在，且不能与目标清点单相同。')
    expect(screen.getByRole('dialog', { name: '合并清点单' })).toBeInTheDocument()
    expect(showToast).not.toHaveBeenCalled()
  })

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
