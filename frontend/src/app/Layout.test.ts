import { cleanup, fireEvent, render, screen } from '@testing-library/svelte'
import { createRawSnippet } from 'svelte'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { fakeRepo, navigateSpy } = vi.hoisted(() => ({
  fakeRepo: { watchCollectionSummaries: vi.fn() },
  navigateSpy: vi.fn(),
}))
vi.mock('$lib/db', () => ({ repo: fakeRepo }))
vi.mock('$lib/sync', () => ({
  authClient: { session: () => Promise.resolve({ authenticated: false }) },
  syncEngine: { status: { subscribe: () => () => {} } },
}))
vi.mock('./router.svelte', () => ({
  router: { isDesktop: true, route: { name: 'collections' } },
  navigate: navigateSpy,
}))
import Layout from './Layout.svelte'

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

afterEach(() => cleanup())
beforeEach(() => {
  vi.clearAllMocks()
  fakeRepo.watchCollectionSummaries.mockReturnValue({
    subscribe: (next: (value: unknown[]) => void) => {
      next([
        summary('a04', 'A04', 'Temple 2'),
        summary('b01', 'B01', 'Annex'),
        summary('loose', 'Loose room'),
      ])
      return () => {}
    },
  })
})

function railRow(name: string) {
  return screen.queryByRole('link', { name: new RegExp(`^${name}`) })
}

describe('Desktop rail search', () => {
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
})
