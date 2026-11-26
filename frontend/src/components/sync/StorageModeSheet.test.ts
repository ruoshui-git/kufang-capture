import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { repo, authClient } = vi.hoisted(() => ({
  repo: { setStorageMode: vi.fn(), readForExport: vi.fn(), checkStorageMode: vi.fn() },
  authClient: { session: vi.fn() },
}))
vi.mock('$lib/db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('$lib/db')>()),
  repo,
}))
vi.mock('$lib/sync', () => ({
  authClient,
  syncEngine: { status: { subscribe: () => () => {} } },
}))

import StorageModeSheet from './StorageModeSheet.svelte'
import { createRepo } from '$lib/db'
import { accountAuthenticated } from '$lib/sync/account'
import { accountGate } from '$lib/sync/binding'
import type { CollectionSummary, StorageMode } from '$lib/types'
import { toasts } from '../../app/toasts.svelte'

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  vi.unstubAllGlobals()
  vi.useRealTimers()
  accountGate.reset()
  toasts.items = []
})
beforeEach(() => accountAuthenticated.set(true))

const item = {
  collection: { id: 'room', name: 'Room A', storage_mode: 'local_only' },
  entry_count: 4,
  photo_count: 3,
  pending_upload_bytes: 1024 * 1024 * 2,
} as never

const session = { authenticated: true, user: { id: 'owner', name: 'Owner', is_owner: true } }
const revokeWarning =
  "Couldn't stop this collection's read-only links. They still show what was uploaded earlier. Stop them under Settings → Server exports."

async function openSwitchToLocalOnly(storageMode: StorageMode = 'synced') {
  authClient.session.mockResolvedValue(session)
  const collection = await createRepo().createCollection({ name: 'Shared room', storage_mode: storageMode })
  repo.setStorageMode.mockResolvedValue(undefined)
  repo.readForExport.mockResolvedValue({ entries: [], photos: [] })
  repo.checkStorageMode.mockResolvedValue({ allowed: true, blockers: [] })
  render(StorageModeSheet, {
    props: {
      item: { collection: { ...collection, storage_mode: 'synced' } } as CollectionSummary,
      open: true,
    },
  })
  const confirm = screen.getByRole('button', { name: 'Switch to Local Only' })
  await waitFor(() => expect(confirm).toBeEnabled())
  return { confirm, id: collection.id }
}

function expectLocalSwitch(id: string) {
  expect(repo.setStorageMode).toHaveBeenCalledExactlyOnceWith(id, 'local_only', {
    consentToUploadExisting: false,
  })
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => (resolve = done))
  return { promise, resolve }
}

describe('StorageModeSheet', () => {
  it('requires explicit upload consent before changing storage mode', async () => {
    authClient.session.mockResolvedValue({ authenticated: true })
    repo.setStorageMode.mockResolvedValue(undefined)
    repo.readForExport.mockResolvedValue({
      entries: Array.from({ length: 4 }),
      photos: Array.from({ length: 3 }, () => ({ byte_size: (2 * 1024 * 1024) / 3 })),
    })
    repo.checkStorageMode.mockResolvedValue({ allowed: true, blockers: [] })
    render(StorageModeSheet, { props: { item, open: true } })
    expect(
      await screen.findByText(/Upload this collection's 4 entries and 3 photos \(2\.0 MB\)/),
    ).toBeInTheDocument()
    const confirm = screen.getByRole('button', { name: 'Sync to Server' })
    expect(confirm).toBeDisabled()
    expect(repo.setStorageMode).not.toHaveBeenCalled()
    await fireEvent.click(screen.getByLabelText(/I understand this uploads/))
    await fireEvent.click(confirm)
    await waitFor(() =>
      expect(repo.setStorageMode).toHaveBeenCalledWith('room', 'synced', { consentToUploadExisting: true }),
    )
  })

  it('lists shared Local Only blockers and disables the storage mode switch', async () => {
    authClient.session.mockResolvedValue({ authenticated: true })
    repo.readForExport.mockResolvedValue({ entries: [], photos: [] })
    repo.checkStorageMode.mockResolvedValue({
      allowed: false,
      blockers: [
        { collection_id: 'other', collection_name: 'B', storage_mode: 'local_only', shared_items: 3 },
      ],
    })
    render(StorageModeSheet, { props: { item, open: true } })
    expect(
      await screen.findByText(
        "3 items are shared with Local Only collection 'B'. Remove them from one side, or switch both.",
      ),
    ).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Sync to Server' })).toBeDisabled()
  })

  it('shows the repository error when a storage mode change fails', async () => {
    authClient.session.mockResolvedValue({ authenticated: true })
    repo.readForExport.mockResolvedValue({ entries: [], photos: [] })
    repo.checkStorageMode.mockResolvedValue({ allowed: true, blockers: [] })
    repo.setStorageMode.mockRejectedValue(new Error('Storage mode changed elsewhere'))
    render(StorageModeSheet, { props: { item, open: true } })
    await fireEvent.click(await screen.findByLabelText(/I understand this uploads/))
    await fireEvent.click(screen.getByRole('button', { name: 'Sync to Server' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Storage mode changed elsewhere')
  })

  it('does not re-check (and briefly disable the button) when the live summary updates', async () => {
    authClient.session.mockResolvedValue({ authenticated: true })
    repo.readForExport.mockResolvedValue({ entries: [], photos: [] })
    repo.checkStorageMode.mockReset()
    repo.checkStorageMode.mockResolvedValue({ allowed: true, blockers: [] })
    const view = render(StorageModeSheet, { props: { item, open: true } })
    await fireEvent.click(await screen.findByLabelText(/I understand this uploads/))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Sync to Server' })).toBeEnabled())
    // A sync status tick delivers a new summary object for the same collection and mode.
    await view.rerender({
      item: {
        collection: { id: 'room', name: 'Room A', storage_mode: 'local_only' },
        entry_count: 5,
        photo_count: 3,
        pending_upload_bytes: 0,
      } as never,
      open: true,
    })
    expect(screen.getByRole('button', { name: 'Sync to Server' })).toBeEnabled()
    expect(repo.checkStorageMode).toHaveBeenCalledTimes(1)
  })

  it('revokes all read-only links before switching to Local Only', async () => {
    const { confirm, id } = await openSwitchToLocalOnly()
    expect(screen.getByText('Read-only links to this collection will stop working.')).toBeInTheDocument()
    const first = deferred<Response>()
    const fetchMock = vi.fn(async (path: string, _init: RequestInit) => {
      if (path === '/api/auth/session') return Response.json(session)
      if (path === '/api/shares/first') return first.promise
      if (path === '/api/shares/second') return new Response(null, { status: 204 })
      return Response.json({ shares: [{ id: 'first' }, { id: 'second' }] })
    })
    vi.stubGlobal('fetch', fetchMock)
    await fireEvent.click(confirm)
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(`/api/shares?collection_id=${id}`, expect.anything())
      for (const link of ['first', 'second'])
        expect(fetchMock).toHaveBeenCalledWith(
          `/api/shares/${link}`,
          expect.objectContaining({ method: 'DELETE' }),
        )
    })
    expect(repo.setStorageMode).not.toHaveBeenCalled()
    expect(confirm).toBeDisabled()
    first.resolve(new Response(null, { status: 204 }))
    await waitFor(() => expectLocalSwitch(id))
    expect(toasts.items).toEqual([])
  })

  it.each(['offline', 'signed out', 'failed revoke'])('switches and warns when %s', async (failure) => {
    const { confirm, id } = await openSwitchToLocalOnly()
    vi.stubGlobal(
      'fetch',
      vi.fn(async (path: string) => {
        if (failure === 'offline') throw new TypeError('offline')
        if (path === '/api/auth/session')
          return Response.json(failure === 'signed out' ? { authenticated: false } : session)
        if (path === '/api/shares/link') return Response.json({}, { status: 500 })
        return Response.json({ shares: [{ id: 'link' }] })
      }),
    )
    await fireEvent.click(confirm)
    await waitFor(() => expectLocalSwitch(id))
    expect(toasts.items).toEqual([expect.objectContaining({ message: revokeWarning, persistent: true })])
  })

  it('switches and warns at the deadline even if the list body stalls', async () => {
    const { confirm, id } = await openSwitchToLocalOnly()
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const listRead = deferred<AbortSignal>()
    vi.stubGlobal(
      'fetch',
      vi.fn(async (path: string, init: RequestInit) => {
        if (path === '/api/auth/session') return Response.json(session)
        return {
          ok: true,
          json: () => {
            listRead.resolve(init.signal!)
            return new Promise(() => {})
          },
        }
      }),
    )
    await fireEvent.click(confirm)
    const signal = await listRead.promise
    await vi.advanceTimersByTimeAsync(7_999)
    expect(repo.setStorageMode).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(1)

    expect(signal.aborted).toBe(true)
    expectLocalSwitch(id)
    expect(toasts.items).toEqual([expect.objectContaining({ message: revokeWarning, persistent: true })])
  })

  it('sends no request if the collection is already Local Only when the confirmation is tapped', async () => {
    // The sheet still displays a synced summary after the database changed in another tab.
    const { confirm, id } = await openSwitchToLocalOnly('local_only')
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    await fireEvent.click(confirm)
    await waitFor(() => expectLocalSwitch(id))
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
