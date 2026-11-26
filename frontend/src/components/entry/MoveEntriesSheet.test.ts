import { m } from '$lib/paraglide/messages.js'
import { setLocale } from '$lib/paraglide/runtime.js'
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

it('localizes the in-progress bulk move and preserves the repository error', async () => {
  repo.watchEntryRows.mockReturnValue(watch([row('entry-1', 1, '纸箱')]))
  repo.watchCollectionSummaries.mockReturnValue(watch([room('other', '二号库房')]))
  let rejectMove!: (reason: Error) => void
  repo.moveEntries.mockImplementation(() => new Promise((_resolve, reject) => (rejectMove = reject)))
  await setLocale('zh-CN', { reload: false })
  try {
    render(MoveEntriesSheet, {
      props: {
        collectionId: 'source',
        sourceName: '一号库房',
        folder: '',
        storageMode: 'local_only',
        open: true,
      },
    })
    expect(screen.getByLabelText('新清点单名称')).toHaveValue('一号库房（拆分）')
    await fireEvent.click(screen.getByRole('checkbox', { name: /纸箱/ }))
    await fireEvent.click(screen.getByRole('radio', { name: '二号库房' }))
    await fireEvent.click(screen.getByRole('button', { name: '移动 1 个条目' }))
    expect(screen.getByRole('button', { name: '正在移动…' })).toBeDisabled()
    rejectMove(new Error(m.core_select_active_entry()))
    expect(await screen.findByRole('alert')).toHaveTextContent('请至少选择一个有效条目')
  } finally {
    await setLocale('en', { reload: false })
  }
})
