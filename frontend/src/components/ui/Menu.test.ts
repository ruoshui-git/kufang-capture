import { cleanup, fireEvent, render, screen } from '@testing-library/svelte'
import { afterEach, describe, expect, it, vi } from 'vitest'
import MenuHarness from './test/MenuHarness.svelte'

afterEach(cleanup)

function setup() {
  const onpick = vi.fn()
  const view = render(MenuHarness, { props: { onpick } })
  const menu = view.container.querySelector('details') as HTMLDetailsElement
  const summary = screen.getByLabelText('Entry actions')
  return { onpick, menu, summary }
}

async function open(menu: HTMLDetailsElement, summary: HTMLElement) {
  await fireEvent.click(summary)
  menu.open = true
  await fireEvent(menu, new Event('toggle'))
  expect(menu.open).toBe(true)
}

describe('Menu', () => {
  it('closes on a tap anywhere outside it', async () => {
    const { menu, summary } = setup()
    await open(menu, summary)
    await fireEvent.pointerDown(screen.getByText('Outside the menu'))
    expect(menu.open).toBe(false)
  })

  it('stays open for taps inside it and closes once an item is chosen', async () => {
    const { onpick, menu, summary } = setup()
    await open(menu, summary)
    const item = screen.getByRole('menuitem', { name: 'Delete entry' })
    await fireEvent.pointerDown(item)
    expect(menu.open).toBe(true)
    await fireEvent.click(item)
    expect(onpick).toHaveBeenCalledOnce()
    expect(menu.open).toBe(false)
  })

  it('closes on Escape', async () => {
    const { menu, summary } = setup()
    await open(menu, summary)
    await fireEvent.keyDown(document, { key: 'Escape' })
    expect(menu.open).toBe(false)
  })
})
