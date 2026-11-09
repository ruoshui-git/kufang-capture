import { fireEvent, render, screen, waitFor } from '@testing-library/svelte'
import { describe, expect, it, vi } from 'vitest'

const { syncEngine } = vi.hoisted(() => ({
  syncEngine: {
    conflicts: { subscribe: vi.fn() },
    resolveConflict: vi.fn(),
  },
}))
vi.mock('$lib/sync', () => ({ syncEngine }))

import ConflictSheet from './ConflictSheet.svelte'

describe('ConflictSheet', () => {
  it('shows local and server field values and resolves with the selected choice', async () => {
    syncEngine.conflicts.subscribe.mockImplementation((next: (rows: unknown[]) => void) => {
      next([
        {
          id: 'conflict-1',
          entity: 'entry',
          entity_id: 'entry-1',
          fields: ['notes'],
          local_values: { notes: 'Counted here' },
          server_values: { notes: 'Counted remotely' },
        },
      ])
      return () => {}
    })
    syncEngine.resolveConflict.mockResolvedValue(undefined)
    render(ConflictSheet, { props: { open: true } })
    expect(await screen.findByText('Counted here')).toBeInTheDocument()
    expect(screen.getByText('Counted remotely')).toBeInTheDocument()
    await fireEvent.click(screen.getByRole('button', { name: 'Use server' }))
    await waitFor(() => expect(syncEngine.resolveConflict).toHaveBeenCalledWith('conflict-1', 'server'))
  })

  it('labels shared item conflicts as Item fields', async () => {
    syncEngine.conflicts.subscribe.mockImplementation((next: (rows: unknown[]) => void) => {
      next([
        {
          id: 'conflict-item',
          entity: 'item',
          entity_id: 'item-1',
          fields: ['title'],
          local_values: { title: 'Local title' },
          server_values: { title: 'Server title' },
        },
      ])
      return () => {}
    })
    render(ConflictSheet, { props: { open: true } })
    expect(await screen.findByRole('heading', { name: 'Item fields' })).toBeInTheDocument()
    expect(screen.getByText('Local title')).toBeInTheDocument()
  })
})
