import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte'
import { afterEach, describe, expect, it, vi } from 'vitest'
import StarredPage from './StarredPage.svelte'

vi.mock('$lib/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('$lib/db')>()
  return { repo: actual.createRepo({ databaseName: `starred-page-${Date.now()}` }) }
})
vi.mock('../../app/router.svelte', () => ({ navigate: vi.fn() }))
const { repo } = await import('$lib/db')

afterEach(cleanup)

describe('Starred page', () => {
  it('shows sequence, display title, review state and archived collection, and can unstar', async () => {
    const collection = await repo.createCollection({
      name: `Archived room ${Date.now()}`,
      folder: 'North wing',
      storage_mode: 'local_only',
    })
    const entry = await repo.createEntry(collection.id, { title: 'Brass candlesticks' })
    await repo.updateEntry(entry.id, { review_status: 'needs_review' })
    await repo.setEntryStarred(entry.id, true)
    await repo.archiveCollection(collection.id)

    render(StarredPage)
    expect(await screen.findByText(collection.name)).toBeInTheDocument()
    expect(screen.getByText('#0001')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /Brass candlesticks/ })).toHaveAttribute(
      'href',
      `/c/${collection.id}/e/${entry.id}`,
    )
    expect(screen.getByText('Needs review')).toBeInTheDocument()
    expect(screen.getByText('Archived')).toBeInTheDocument()
    await fireEvent.click(screen.getByRole('button', { name: 'Unstar entry' }))
    await waitFor(() => expect(screen.getByText(/No starred entries yet/)).toBeInTheDocument())
  })
})
