import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte'
import { afterEach, describe, expect, it, vi } from 'vitest'
import Tag from './Tag.svelte'
import ToastHost from './ToastHost.svelte'
import { showToast, toasts } from '../../app/toasts.svelte'

afterEach(() => {
  cleanup()
  toasts.items = []
})

describe('Tag', () => {
  it('shows a formatted sequence and describes the incomplete fold', () => {
    render(Tag, { props: { sequence: 7, incomplete: true } })
    expect(screen.getByLabelText('#0007, incomplete')).toBeInTheDocument()
    expect(screen.getByText('#0007')).toBeInTheDocument()
  })
})

describe('Toast host', () => {
  it('runs the Undo action and dismisses the toast', async () => {
    const undo = vi.fn()
    render(ToastHost)
    showToast({ message: 'Deleted', actionLabel: 'Undo', action: undo })
    await fireEvent.click(await screen.findByRole('button', { name: 'Undo' }))
    expect(undo).toHaveBeenCalledOnce()
    await waitFor(() => expect(screen.queryByText('Deleted')).not.toBeInTheDocument())
  })
  it('dismisses a toast after its default eight second timeout', () => {
    vi.useFakeTimers()
    showToast({ message: 'Saved' })
    expect(toasts.items).toHaveLength(1)
    vi.advanceTimersByTime(8000)
    expect(toasts.items).toHaveLength(0)
    vi.useRealTimers()
  })
})
