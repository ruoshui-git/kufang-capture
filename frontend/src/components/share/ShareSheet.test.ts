import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte'
import { afterEach, expect, it, vi } from 'vitest'
import { repo } from '$lib/db'
import { accountGate } from '$lib/sync/binding'
import type { ShareLink } from '$lib/share/contract'
import ShareSheet from './ShareSheet.svelte'

const session = { authenticated: true, user: { id: 'owner', name: 'Owner', is_owner: true } }

afterEach(() => {
  cleanup()
  accountGate.reset()
  vi.unstubAllGlobals()
})

async function openSyncedSheet(fetcher: typeof fetch) {
  const collection = await repo.createCollection({ name: 'Synced room', storage_mode: 'synced' })
  vi.stubGlobal('fetch', fetcher)
  render(ShareSheet, { props: { open: true, storageMode: 'synced', collectionId: collection.id } })
  return collection.id
}

it('offers sign-in with a return link and sends no share request while signed out', async () => {
  const fetcher = vi.fn().mockResolvedValue(new Response(null, { status: 401 }))
  const id = await openSyncedSheet(fetcher)
  expect(await screen.findByRole('link', { name: 'Sign in' })).toHaveAttribute(
    'href',
    `/login?return=${encodeURIComponent(`/c/${id}`)}`,
  )
  expect(fetcher).toHaveBeenCalledExactlyOnceWith('/api/auth/session', expect.anything())
})

it('asks the owner to sync an unavailable server collection first', async () => {
  const fetcher = vi.fn<typeof fetch>((path) =>
    Promise.resolve(
      path === '/api/auth/session'
        ? Response.json(session)
        : Response.json({ detail: 'collection_not_found' }, { status: 404 }),
    ),
  )
  await openSyncedSheet(fetcher)
  expect(await screen.findByRole('alert')).toHaveTextContent('Sync this collection first, then try again.')
  expect(screen.queryByRole('button', { name: 'Create link' })).not.toBeInTheDocument()
})

it('offers a selectable URL if copying fails and requires a second action to revoke', async () => {
  const link: ShareLink = {
    id: 'fixture-link',
    collection_id: 'fixture-collection',
    collection_name: 'Synced room',
    label: null,
    url: `https://example.test/share#${'a'.repeat(43)}`,
    created_at: '2026-11-26T14:00:00.000Z',
    expires_at: null,
    last_viewed_at: null,
    expired: false,
  }
  const fetcher = vi.fn<typeof fetch>(async (path, init) => {
    if (path === '/api/auth/session') return Response.json(session)
    if (init?.method === 'POST') return Response.json(link, { status: 201 })
    if (init?.method === 'DELETE') return new Response(null, { status: 204 })
    return Response.json({ shares: [] })
  })
  await openSyncedSheet(fetcher)
  await screen.findByRole('button', { name: 'Create link' })
  expect(screen.getByRole('radio', { name: '30 days' })).toBeChecked()
  await fireEvent.click(screen.getByRole('radio', { name: 'Never' }))
  await fireEvent.submit(screen.getByRole('button', { name: 'Create link' }).closest('form')!)
  expect(await screen.findByRole('textbox', { name: 'Link URL' })).toHaveValue(link.url)
  expect(screen.getByText('No expiry')).toBeInTheDocument()
  const post = fetcher.mock.calls.find(([, init]) => init?.method === 'POST')
  expect(JSON.parse(post?.[1]?.body as string)).toMatchObject({ expires_in_days: null })

  await fireEvent.click(screen.getByRole('button', { name: 'Revoke' }))
  expect(screen.getByRole('alert')).toHaveTextContent('Anyone with the link will lose access.')
  expect(fetcher.mock.calls.some(([, init]) => init?.method === 'DELETE')).toBe(false)
  await fireEvent.click(screen.getAllByRole('button', { name: 'Revoke' }).at(-1)!)
  await waitFor(() => expect(screen.queryByText('No expiry')).not.toBeInTheDocument())
})
