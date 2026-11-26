import { fireEvent, render, screen, waitFor } from '@testing-library/svelte'
import { describe, expect, it, vi } from 'vitest'
import { setLocale } from '$lib/paraglide/runtime.js'

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
    expect(screen.getByText('Notes')).toBeInTheDocument()
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

  it('translates conflict labels and built-in values while keeping notes as entered', async () => {
    void setLocale('zh-CN', { reload: false })
    try {
      syncEngine.conflicts.subscribe.mockImplementation((next: (rows: unknown[]) => void) => {
        next([
          {
            id: 'conflict-item',
            entity: 'item',
            entity_id: 'item-1',
            fields: ['review_status', 'notes', 'unrecognized_field'],
            local_values: { review_status: 'draft', notes: 'Shelf A' },
            server_values: { review_status: 'complete', notes: 'Shelf B' },
          },
        ])
        return () => {}
      })
      render(ConflictSheet, { props: { open: true } })
      expect(await screen.findByRole('heading', { name: '物品字段' })).toBeInTheDocument()
      for (const text of ['复核状态', '草稿', '已完成', '备注', 'Shelf A', 'Shelf B', '字段']) {
        expect(screen.getByText(text)).toBeInTheDocument()
      }
      expect(screen.getByRole('button', { name: '保留我的版本' })).toBeInTheDocument()
      expect(screen.getByRole('button', { name: '关闭' })).toBeInTheDocument()
    } finally {
      void setLocale('en', { reload: false })
    }
  })
})
