import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte'
import { afterEach, describe, expect, it, vi } from 'vitest'

const { repo, exportFromDevice } = vi.hoisted(() => ({
  repo: { checkClearCollection: vi.fn(), clearCollection: vi.fn() },
  exportFromDevice: vi.fn(),
}))
vi.mock('$lib/db', () => ({ repo }))
vi.mock('$lib/export/device', () => ({ exportFromDevice }))
vi.mock('../../app/toasts.svelte', () => ({ showToast: vi.fn() }))

import ClearCollectionSheet from './ClearCollectionSheet.svelte'

const item = {
  collection: { id: 'room', name: 'Room A' },
} as never

describe('ClearCollectionSheet', () => {
  afterEach(cleanup)
  it('blocks clear until export and exact-name confirmation', async () => {
    repo.checkClearCollection.mockResolvedValue({
      allowed: false,
      reasons: ['Collection has changes that were not exported'],
      shared_items: 2,
    })
    repo.clearCollection.mockResolvedValue(undefined)
    exportFromDevice.mockImplementation(async () => {
      repo.checkClearCollection.mockResolvedValue({ allowed: true, reasons: [] })
      return { delivery: 'download', filename: 'room.zip' }
    })
    render(ClearCollectionSheet, { props: { item, open: true } })
    const clear = await screen.findByRole('button', { name: 'Clear collection' })
    expect(await screen.findByText('Collection has changes that were not exported')).toBeInTheDocument()
    expect(screen.getByText('2 shared items stay in other collections.')).toBeInTheDocument()
    expect(clear).toBeDisabled()
    await fireEvent.click(screen.getByRole('button', { name: 'Export ZIP now' }))
    await waitFor(() => expect(exportFromDevice).toHaveBeenCalledWith(['room']))
    const nameInput = screen.getByLabelText('Type collection name')
    await fireEvent.input(nameInput, { target: { value: 'Room' } })
    expect(clear).toBeDisabled()
    await fireEvent.input(nameInput, { target: { value: 'Room A' } })
    await waitFor(() => expect(clear).toBeEnabled())
    await fireEvent.click(clear)
    await waitFor(() => expect(repo.clearCollection).toHaveBeenCalledWith('room', 'Room A'))
  })

  it('offers Share ZIP when the export needs a fresh tap and refreshes the guard after sharing', async () => {
    repo.checkClearCollection.mockResolvedValue({
      allowed: false,
      reasons: ['Not exported'],
      shared_items: 0,
    })
    const deliverAgain = vi.fn(async () => {
      repo.checkClearCollection.mockResolvedValue({ allowed: true, reasons: [], shared_items: 0 })
      return 'shared'
    })
    exportFromDevice.mockResolvedValue({ delivery: 'needs_tap', filename: 'room.zip', deliverAgain })
    render(ClearCollectionSheet, { props: { item, open: true } })
    await fireEvent.click(await screen.findByRole('button', { name: 'Export ZIP now' }))
    await fireEvent.click(await screen.findByRole('button', { name: 'Share ZIP' }))
    await waitFor(() => expect(deliverAgain).toHaveBeenCalledOnce())
    await waitFor(() => expect(screen.queryByText('Not exported')).not.toBeInTheDocument())
    expect(await screen.findByRole('button', { name: 'Export ZIP now' })).toBeEnabled()
  })
})
