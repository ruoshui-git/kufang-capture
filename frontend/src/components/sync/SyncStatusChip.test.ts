import { cleanup, render, screen, waitFor } from '@testing-library/svelte'
import { describe, expect, it, vi } from 'vitest'
import { setLocale } from '$lib/paraglide/runtime.js'

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
      upload_progress: null,
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

  it('localizes visible and accessible pending-upload copy in Simplified Chinese', () => {
    void setLocale('zh-CN', { reload: false })
    try {
      render(SyncStatusChip, {
        props: { collectionId: 'room', mode: 'synced', pendingCount: 1, pendingBytes: 1572864 },
      })
      const chip = screen.getByRole('status', { name: /1 张照片等待上传（1\.5\sMB）/ })
      expect(chip).toHaveTextContent('1 张照片等待上传（1.5 MB）')
      expect(chip).toHaveAttribute('title', '1 张照片等待上传（1.5\u00a0MB）')
    } finally {
      cleanup()
      void setLocale('en', { reload: false })
    }
  })

  it.each([
    ['en', 'Uploading 2/3 · 40%', 'Sync error — tap to retry', '1 photo pending (1.5 MB)'],
    ['zh-CN', '上传照片 2/3 · 40%', '同步失败，点击重试', '1 张照片等待上传（1.5 MB）'],
  ] as const)(
    'shows collection progress and priority states in %s',
    async (locale, uploading, error, pending) => {
      await setLocale(locale, { reload: false })
      const status = {
        phase: 'syncing',
        authenticated: true,
        per_collection: {
          room: { pending_uploads: 2 },
          other: { pending_uploads: 1, pending_upload_bytes: 1572864 },
        },
        upload_progress: {
          photo_id: 'photo',
          collection_ids: ['room'],
          sent_bytes: 400,
          total_bytes: 1000,
          percent: 40,
          n: 4,
          total: 6,
          per_collection: { room: { n: 2, total: 3 } },
        },
      }
      try {
        for (const [collectionId, value, label, kind] of [
          ['room', status, uploading, 'syncing'],
          ['other', status, pending, 'warn'],
          ['room', { ...status, per_collection: { room: { errors: 1 } } }, error, 'error'],
        ] as const) {
          syncEngine.status.subscribe.mockImplementation((next: (value: unknown) => void) => {
            next(value)
            return () => {}
          })
          const view = render(SyncStatusChip, { props: { collectionId, mode: 'synced' } })
          await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent(label))
          expect(screen.getByRole('status')).toHaveClass(kind)
          view.unmount()
        }
      } finally {
        cleanup()
        await setLocale('en', { reload: false })
      }
    },
  )
})
