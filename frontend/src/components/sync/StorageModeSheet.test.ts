import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte'
import { afterEach, describe, expect, it, vi } from 'vitest'

const { repo, authClient } = vi.hoisted(() => ({
  repo: { setStorageMode: vi.fn(), readForExport: vi.fn(), checkStorageMode: vi.fn() },
  authClient: { session: vi.fn() },
}))
vi.mock('$lib/db', () => ({ repo }))
vi.mock('$lib/sync', () => ({ authClient }))

import StorageModeSheet from './StorageModeSheet.svelte'

afterEach(cleanup)

const item = {
  collection: { id: 'room', name: 'Room A', storage_mode: 'local_only' },
  entry_count: 4,
  photo_count: 3,
  pending_upload_bytes: 1024 * 1024 * 2,
} as never

describe('StorageModeSheet', () => {
  it('requires explicit upload consent before changing storage mode', async () => {
    authClient.session.mockResolvedValue({ authenticated: true })
    repo.setStorageMode.mockResolvedValue(undefined)
    repo.readForExport.mockResolvedValue({
      entries: Array.from({ length: 4 }),
      photos: Array.from({ length: 3 }, () => ({ byte_size: (2 * 1024 * 1024) / 3 })),
    })
    repo.checkStorageMode.mockResolvedValue({ allowed: true, blockers: [] })
    render(StorageModeSheet, { props: { item, open: true } })
    expect(
      await screen.findByText(/Upload this collection's 4 entries and 3 photos \(2\.0 MB\)/),
    ).toBeInTheDocument()
    const confirm = screen.getByRole('button', { name: 'Sync to Server' })
    expect(confirm).toBeDisabled()
    expect(repo.setStorageMode).not.toHaveBeenCalled()
    await fireEvent.click(screen.getByLabelText(/I understand this uploads/))
    await fireEvent.click(confirm)
    await waitFor(() =>
      expect(repo.setStorageMode).toHaveBeenCalledWith('room', 'synced', { consentToUploadExisting: true }),
    )
  })

  it('lists shared Local Only blockers and disables the storage mode switch', async () => {
    authClient.session.mockResolvedValue({ authenticated: true })
    repo.readForExport.mockResolvedValue({ entries: [], photos: [] })
    repo.checkStorageMode.mockResolvedValue({
      allowed: false,
      blockers: [
        { collection_id: 'other', collection_name: 'B', storage_mode: 'local_only', shared_items: 3 },
      ],
    })
    render(StorageModeSheet, { props: { item, open: true } })
    expect(
      await screen.findByText(
        "3 items are shared with Local Only collection 'B'. Remove them from one side, or switch both.",
      ),
    ).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Sync to Server' })).toBeDisabled()
  })

  it('shows the repository error when a storage mode change fails', async () => {
    authClient.session.mockResolvedValue({ authenticated: true })
    repo.readForExport.mockResolvedValue({ entries: [], photos: [] })
    repo.checkStorageMode.mockResolvedValue({ allowed: true, blockers: [] })
    repo.setStorageMode.mockRejectedValue(new Error('Storage mode changed elsewhere'))
    render(StorageModeSheet, { props: { item, open: true } })
    await fireEvent.click(await screen.findByLabelText(/I understand this uploads/))
    await fireEvent.click(screen.getByRole('button', { name: 'Sync to Server' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Storage mode changed elsewhere')
  })

  it('does not re-check (and briefly disable the button) when the live summary updates', async () => {
    authClient.session.mockResolvedValue({ authenticated: true })
    repo.readForExport.mockResolvedValue({ entries: [], photos: [] })
    repo.checkStorageMode.mockReset()
    repo.checkStorageMode.mockResolvedValue({ allowed: true, blockers: [] })
    const view = render(StorageModeSheet, { props: { item, open: true } })
    await fireEvent.click(await screen.findByLabelText(/I understand this uploads/))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Sync to Server' })).toBeEnabled())
    // A sync status tick delivers a new summary object for the same collection and mode.
    await view.rerender({
      item: {
        collection: { id: 'room', name: 'Room A', storage_mode: 'local_only' },
        entry_count: 5,
        photo_count: 3,
        pending_upload_bytes: 0,
      } as never,
      open: true,
    })
    expect(screen.getByRole('button', { name: 'Sync to Server' })).toBeEnabled()
    expect(repo.checkStorageMode).toHaveBeenCalledTimes(1)
  })
})
