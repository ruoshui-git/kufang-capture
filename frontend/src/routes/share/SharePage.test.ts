import { cleanup, fireEvent, render, screen } from '@testing-library/svelte'
import { afterEach, expect, it, vi } from 'vitest'
import type { SharedCollection } from '$lib/share/contract'
import SharePage from './SharePage.svelte'

const token = 'c'.repeat(43)
const updated = '2026-11-26T14:00:00.000Z'
const snapshot: SharedCollection = {
  schema: 1,
  share: { label: null, expires_at: null },
  collection: {
    id: 'room',
    name: 'Storeroom',
    folder: '',
    description: '',
    status: 'active',
    archived_at: null,
  },
  updated_at: updated,
  entries: [
    {
      id: 'entry',
      item_id: 'item',
      sequence_number: 42,
      title: 'Incense',
      quantity: null,
      unit: '',
      count_detail: '',
      entry_notes: '',
      notes: '',
      expiration_date: null,
      dimensions: '',
      review_status: 'needs_review',
      created_at: updated,
      updated_at: updated,
      photos: [],
    },
  ],
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  history.replaceState(null, '', '/')
})

it('rejects a malformed entry fragment before issuing a request', async () => {
  history.replaceState(null, '', `/share#${token}/e/-42`)
  const fetcher = vi.fn()
  vi.stubGlobal('fetch', fetcher)
  render(SharePage)
  expect(await screen.findByRole('alert')).toHaveTextContent("This link doesn't work.")
  expect(fetcher).not.toHaveBeenCalled()
})

it('retries a network failure and opens the requested entry directly', async () => {
  history.replaceState(null, '', `/share#${token}/e/42`)
  const fetcher = vi
    .fn()
    .mockRejectedValueOnce(new TypeError('offline'))
    .mockResolvedValueOnce(Response.json(snapshot))
  vi.stubGlobal('fetch', fetcher)
  render(SharePage)
  expect(await screen.findByRole('alert')).toHaveTextContent("Couldn't reach the server.")
  await fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
  const panel = await screen.findByRole('dialog', { name: 'Incense' })
  expect(panel).toHaveTextContent('Copy link to this entry')
  expect(fetcher).toHaveBeenCalledTimes(2)
  await fireEvent.click(screen.getByRole('button', { name: 'Close' }))
  expect(location.hash).toBe(`#${token}`)
  expect(fetcher).toHaveBeenCalledTimes(2)
})
