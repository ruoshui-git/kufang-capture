import { cleanup, render, screen, waitFor } from '@testing-library/svelte'
import { describe, expect, it, vi } from 'vitest'

const { repo, syncEngine, current } = vi.hoisted(() => ({
  repo: { readForExport: vi.fn() },
  syncEngine: { status: { subscribe: vi.fn() } },
  current: { value: null as unknown },
}))
vi.mock('$lib/db', () => ({ repo }))
vi.mock('$lib/sync', () => ({ syncEngine }))

import SyncStatusChip from './SyncStatusChip.svelte'

describe('SyncStatusChip', () => {
  it('shows Local Only and pending upload text', () => {
    cleanup()
    const { unmount } = render(SyncStatusChip, {
      props: { collectionId: 'room', mode: 'local_only' },
    })
    expect(screen.getByRole('status')).toHaveTextContent('Local Only')
    unmount()
    render(SyncStatusChip, {
      props: { collectionId: 'room', mode: 'synced', pendingCount: 3, pendingBytes: 25165824 },
    })
    expect(screen.getByRole('status')).toHaveTextContent('3 photos pending (24 MB)')
    cleanup()
  })

  it('shows backed up, signing in, syncing, and retry states', async () => {
    cleanup()
    syncEngine.status.subscribe.mockImplementation((next: (value: unknown) => void) => {
      next(current.value)
      return () => {}
    })
    const base = {
      online: true,
      authenticated: true,
      last_success_at: null,
      last_error: null,
      pending_mutations: 0,
      pending_uploads: 0,
      pending_upload_bytes: 0,
      conflicts: 0,
      per_collection: {},
    }
    current.value = { ...base, phase: 'idle' }
    const view = render(SyncStatusChip, { props: { collectionId: 'room', mode: 'synced' } })
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Backed up'))
    view.unmount()
    cleanup()

    for (const [status, expected] of [
      [{ ...base, phase: 'signed_out', authenticated: false }, 'Sign in to sync'],
      [{ ...base, phase: 'syncing' }, 'Syncing'],
      [{ ...base, phase: 'error', per_collection: { room: { errors: 1 } } }, 'Sync error — tap to retry'],
      [{ ...base, phase: 'idle', per_collection: { room: { conflicts: 1 } } }, 'Conflict (1)'],
    ] as const) {
      current.value = status
      render(SyncStatusChip, { props: { collectionId: 'room', mode: 'synced' } })
      await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent(expected))
      cleanup()
    }
  })
})
