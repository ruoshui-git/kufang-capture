import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte'
import { createRawSnippet } from 'svelte'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { fakeRepo, navigateSpy, shared } = vi.hoisted(() => ({
  fakeRepo: { watchCollectionSummaries: vi.fn() },
  navigateSpy: vi.fn(),
  shared: { statusListener: undefined as ((value: unknown) => void) | undefined },
}))
vi.mock('$lib/db', () => ({ repo: fakeRepo }))
vi.mock('$lib/sync', () => ({
  authClient: { session: () => Promise.resolve({ authenticated: false }) },
  syncEngine: {
    status: {
      subscribe: (listener: (value: unknown) => void) => {
        shared.statusListener = listener
        return () => {}
      },
    },
  },
}))
vi.mock('./router.svelte', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./router.svelte')>()
  return { ...actual, navigate: navigateSpy }
})
import Layout from './Layout.svelte'
import { router } from './router.svelte'
import { accountAuthenticated } from '$lib/sync/account'
import { setLocale } from '$lib/paraglide/runtime.js'

function summary(id: string, name: string, folder = '') {
  return {
    collection: { id, name, folder, description: '', status: 'active', storage_mode: 'local_only' },
    entry_count: 1,
    photo_count: 0,
    incomplete_count: 0,
    pending_sync_count: 0,
    pending_upload_bytes: 0,
    last_activity_at: '2026-11-08T00:00:00.000Z',
    quantity_by_unit: [],
  }
}

const children = createRawSnippet(() => ({ render: () => '<p>page</p>' }))
let unsubscribeSummary: ReturnType<typeof vi.fn>

afterEach(async () => {
  cleanup()
  await setLocale('en', { reload: false })
})
beforeEach(() => {
  vi.clearAllMocks()
  shared.statusListener = undefined
  accountAuthenticated.set(null)
  router.isDesktop = true
  unsubscribeSummary = vi.fn()
  fakeRepo.watchCollectionSummaries.mockReturnValue({
    subscribe: (next: (value: unknown[]) => void) => {
      next([
        summary('a04', 'A04', 'Temple 2'),
        summary('b01', 'B01', 'Annex'),
        summary('loose', 'Loose room'),
      ])
      return unsubscribeSummary
    },
  })
})

function railRow(name: string) {
  return screen.queryByRole('link', { name: new RegExp(`^${name}`) })
}

describe('Desktop rail search', () => {
  it('uses Chinese in sync status, including plural uploads and fallback errors', async () => {
    await setLocale('zh-CN', { reload: false })
    const { container } = render(Layout, { children })
    const slot = container.querySelector('.global-sync')
    await waitFor(() => expect(shared.statusListener).toBeTypeOf('function'))
    const status = {
      phase: 'syncing',
      online: true,
      authenticated: true,
      last_success_at: null,
      last_error: null,
      pending_mutations: 1,
      pending_uploads: 2,
      pending_upload_bytes: 262144,
      conflicts: 0,
      per_collection: {},
    }
    accountAuthenticated.set(true)
    shared.statusListener?.(status)
    await waitFor(() => expect(slot).toHaveTextContent('2 张照片待上传（0.3 MB）'))
    shared.statusListener?.({ ...status, pending_uploads: 0, phase: 'idle' })
    await waitFor(() => expect(slot).toHaveTextContent('更改等待同步'))
    shared.statusListener?.({ ...status, phase: 'offline' })
    await waitFor(() => expect(slot).toHaveTextContent('已保存到本设备，联网后将同步。'))
    shared.statusListener?.({ ...status, phase: 'error' })
    await waitFor(() => expect(slot).toHaveTextContent('同步出错。请检查网络连接后重试。'))
  })

  it('keeps the polite sync slot mounted while its message changes', async () => {
    const { container } = render(Layout, { children })
    const slot = container.querySelector('.global-sync')
    expect(slot).toHaveAttribute('aria-live', 'polite')
    await waitFor(() => expect(shared.statusListener).toBeTypeOf('function'))
    shared.statusListener?.({
      phase: 'syncing',
      online: true,
      authenticated: true,
      last_success_at: null,
      last_error: null,
      pending_mutations: 1,
      pending_uploads: 0,
      pending_upload_bytes: 0,
      conflicts: 0,
      per_collection: {},
    })
    accountAuthenticated.set(true)
    expect(container.querySelector('.global-sync')).toBe(slot)
    await waitFor(() => expect(slot).toHaveTextContent('Syncing'))
  })

  it('filters rows and hides folder labels without matches', async () => {
    render(Layout, { children })
    expect(railRow('A04')).toBeInTheDocument()
    expect(screen.getByText('Annex')).toBeInTheDocument()

    await fireEvent.input(screen.getByRole('searchbox', { name: 'Filter collections' }), {
      target: { value: 'temple' },
    })
    expect(railRow('A04')).toHaveAttribute('href', '/c/a04')
    expect(railRow('B01')).not.toBeInTheDocument()
    expect(railRow('Loose room')).not.toBeInTheDocument()
    expect(screen.getByText('Temple 2')).toBeInTheDocument()
    expect(screen.queryByText('Annex')).not.toBeInTheDocument()
    expect(screen.queryByText('No matches')).not.toBeInTheDocument()
  })

  it('shows No matches when nothing matches', async () => {
    render(Layout, { children })
    await fireEvent.input(screen.getByRole('searchbox', { name: 'Filter collections' }), {
      target: { value: 'zzz' },
    })
    expect(screen.getByRole('status')).toHaveTextContent('No matches')
    expect(railRow('A04')).not.toBeInTheDocument()
  })

  it('opens the only match on Enter and does nothing with several matches', async () => {
    render(Layout, { children })
    const input = screen.getByRole('searchbox', { name: 'Filter collections' })
    await fireEvent.input(input, { target: { value: 'a' } })
    await fireEvent.keyDown(input, { key: 'Enter' })
    expect(navigateSpy).not.toHaveBeenCalled()

    await fireEvent.input(input, { target: { value: 'loose' } })
    await fireEvent.keyDown(input, { key: 'Enter' })
    expect(navigateSpy).toHaveBeenCalledWith('/c/loose')
  })

  it('clears the filter on Escape', async () => {
    render(Layout, { children })
    const input = screen.getByRole('searchbox', { name: 'Filter collections' }) as HTMLInputElement
    await fireEvent.input(input, { target: { value: 'temple' } })
    expect(railRow('B01')).not.toBeInTheDocument()
    await fireEvent.keyDown(input, { key: 'Escape' })
    expect(input.value).toBe('')
    expect(railRow('B01')).toBeInTheDocument()
  })

  it('subscribes to summaries only while the desktop rail is shown', async () => {
    router.isDesktop = false
    const view = render(Layout, { children })
    expect(fakeRepo.watchCollectionSummaries).not.toHaveBeenCalled()
    expect(screen.queryByRole('complementary', { name: 'Collections' })).not.toBeInTheDocument()

    router.isDesktop = true
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(fakeRepo.watchCollectionSummaries).toHaveBeenCalledTimes(1)
    router.isDesktop = false
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(unsubscribeSummary).toHaveBeenCalledTimes(1)
    view.unmount()
  })
})
