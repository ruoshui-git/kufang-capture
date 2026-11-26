import { cleanup, fireEvent, render, screen } from '@testing-library/svelte'
import { afterEach, expect, it, vi } from 'vitest'
import { setLocale } from '$lib/paraglide/runtime.js'
import { toasts } from './app/toasts.svelte'
import App from './App.svelte'

const { registerSW, updateSW } = vi.hoisted(() => ({
  registerSW: vi.fn(),
  updateSW: vi.fn(),
}))
vi.mock('virtual:pwa-register', () => ({ registerSW }))
vi.mock('$lib/sync', () => ({
  syncEngine: { start: vi.fn(), status: { subscribe: () => () => {} } },
}))

afterEach(async () => {
  cleanup()
  toasts.items = []
  window.history.replaceState({}, '', '/')
  await setLocale('en', { reload: false })
})

it('offers a Chinese reload action when a service worker update is waiting', async () => {
  await setLocale('zh-CN', { reload: false })
  registerSW.mockReturnValue(updateSW)
  render(App)
  expect(registerSW).toHaveBeenCalledOnce()
  registerSW.mock.calls[0]![0].onNeedRefresh()

  expect(await screen.findByText('有新版本')).toBeInTheDocument()
  await fireEvent.click(screen.getByRole('button', { name: '重新加载' }))
  expect(updateSW).toHaveBeenCalledWith(true)
})
