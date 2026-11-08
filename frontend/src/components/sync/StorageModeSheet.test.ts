import { fireEvent, render, screen, waitFor } from '@testing-library/svelte'
import { describe, expect, it, vi } from 'vitest'

const { repo, authClient } = vi.hoisted(() => ({
  repo: { setStorageMode: vi.fn(), readForExport: vi.fn() },
  authClient: { session: vi.fn() },
}))
vi.mock('$lib/db', () => ({ repo }))
vi.mock('$lib/sync', () => ({ authClient }))

import StorageModeSheet from './StorageModeSheet.svelte'

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
})
