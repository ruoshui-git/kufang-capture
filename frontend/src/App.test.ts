import { cleanup, fireEvent, render, screen } from '@testing-library/svelte'
import { afterEach, expect, it, vi } from 'vitest'
import { m } from '$lib/paraglide/messages.js'
import { setLocale } from '$lib/paraglide/runtime.js'
import { toasts } from './app/toasts.svelte'
import App from './App.svelte'

const { registerSW, startSync, updateSW } = vi.hoisted(() => ({
  registerSW: vi.fn(),
  updateSW: vi.fn(),
  startSync: vi.fn(),
}))
vi.mock('virtual:pwa-register', () => ({ registerSW }))
vi.mock('$lib/sync', () => ({
  syncEngine: { start: startSync, status: { subscribe: () => () => {} } },
}))

afterEach(async () => {
  cleanup()
  await vi.dynamicImportSettled()
  vi.clearAllMocks()
  vi.unstubAllGlobals()
  toasts.items = []
  window.history.replaceState({}, '', '/')
  window.dispatchEvent(new PopStateEvent('popstate'))
  await setLocale('en', { reload: false })
})

it('offers a Chinese reload action when a service worker update is waiting', async () => {
  await setLocale('zh-CN', { reload: false })
  registerSW.mockReturnValue(updateSW)
  render(App)
  expect(screen.getByRole('heading', { name: m.shell_collections() })).toBeInTheDocument()
  expect(registerSW).toHaveBeenCalledOnce()
  registerSW.mock.calls[0]![0].onNeedRefresh()

  expect(await screen.findByText('有新版本')).toBeInTheDocument()
  await fireEvent.click(screen.getByRole('button', { name: '重新加载' }))
  expect(updateSW).toHaveBeenCalledWith(true)
})

it('serves a fresh share URL without opening IndexedDB, starting sync or checking sign-in', async () => {
  const token = 't'.repeat(43)
  window.history.replaceState(null, '', `/share#${token}`)
  window.dispatchEvent(new PopStateEvent('popstate'))
  const openDb = vi.spyOn(indexedDB, 'open')
  const mockFetch = vi.fn().mockResolvedValue(
    Response.json({
      schema: 1,
      share: { label: null, expires_at: null },
      collection: {
        id: 'room',
        name: 'Shared room',
        description: '',
        folder: '',
        status: 'active',
        archived_at: null,
      },
      updated_at: '2026-11-26T16:45:00.000Z',
      entries: [],
    }),
  )
  vi.stubGlobal('fetch', mockFetch)
  render(App)
  expect(await screen.findByRole('heading', { name: 'Shared room' })).toBeInTheDocument()
  expect(screen.queryByText('New Entry')).not.toBeInTheDocument()
  expect(mockFetch).toHaveBeenCalledExactlyOnceWith(
    '/api/share',
    expect.objectContaining({ credentials: 'omit' }),
  )
  expect(openDb).not.toHaveBeenCalled()
  expect(startSync).not.toHaveBeenCalled()

  // The shared page always reads the server, so it never claims to work offline.
  registerSW.mock.calls[0]![0].onOfflineReady()
  expect(toasts.items).toEqual([])
})
