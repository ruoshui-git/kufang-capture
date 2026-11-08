import { cleanup, render, screen, waitFor } from '@testing-library/svelte'
import { afterEach, describe, expect, it } from 'vitest'
import Sheet from './Sheet.svelte'

afterEach(() => cleanup())

describe('Sheet', () => {
  it('focuses its first control, traps Tab, and closes on Escape', async () => {
    Object.defineProperty(HTMLDialogElement.prototype, 'showModal', {
      configurable: true,
      value(this: HTMLDialogElement) {
        this.setAttribute('open', '')
      },
    })
    Object.defineProperty(HTMLDialogElement.prototype, 'close', {
      configurable: true,
      value(this: HTMLDialogElement) {
        this.removeAttribute('open')
        this.dispatchEvent(new Event('close'))
      },
    })
    const children = () => null
    render(Sheet, { props: { open: true, title: 'New collection', children: children as never } })
    const dialog = screen.getByRole('dialog', { name: 'New collection' })
    const close = screen.getByRole('button', { name: 'Close' })
    expect(dialog).toHaveAttribute('open')
    await waitFor(() => expect(close).toHaveFocus())
    close.focus()
    close.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }))
    expect(close).toHaveFocus()
    close.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    await waitFor(() => expect(dialog).not.toHaveAttribute('open'))
  })
})
