import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte'
import { afterEach, describe, expect, it, vi } from 'vitest'
import StarredPage from './StarredPage.svelte'

vi.mock('$lib/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('$lib/db')>()
  return { repo: actual.createRepo({ databaseName: `starred-page-${Date.now()}` }) }
})
vi.mock('../../app/router.svelte', () => ({ navigate: vi.fn() }))
const { repo } = await import('$lib/db')

const starredIds: string[] = []
async function star(id: string) {
  starredIds.push(id)
  await repo.setEntryStarred(id, true)
}

// The repo database is shared across tests; unstar what each test starred so later tests start empty.
afterEach(async () => {
  cleanup()
  await Promise.all(starredIds.splice(0).map((id) => repo.setEntryStarred(id, false)))
})

describe('Starred page', () => {
  it('shows normalized shared and collection notes without quantity details', async () => {
    const collection = await repo.createCollection({
      name: `Notes ${Date.now()}`,
      storage_mode: 'local_only',
    })
    const entry = await repo.createEntry(collection.id, { title: 'Notes item' })
    await repo.updateEntry(entry.id, {
      notes: 'Shared\nitem',
      entry_notes: ' Collection   note ',
      quantity: '5',
      unit: 'boxes',
    })
    await star(entry.id)
    render(StarredPage)
    expect(await screen.findByText('Shared item · Collection note')).toBeInTheDocument()
    expect(screen.queryByText('5')).not.toBeInTheDocument()
    expect(screen.queryByText('boxes')).not.toBeInTheDocument()
  })

  it('shows only entry notes and omits blank notes', async () => {
    const collection = await repo.createCollection({
      name: `Entry notes ${Date.now()}`,
      storage_mode: 'local_only',
    })
    const entry = await repo.createEntry(collection.id, { title: 'Entry note item' })
    await repo.updateEntry(entry.id, { entry_notes: '  Just this note  ' })
    await star(entry.id)
    const blank = await repo.createEntry(collection.id, { title: 'Blank note item' })
    await repo.updateEntry(blank.id, { notes: '  ', entry_notes: '\n ' })
    await star(blank.id)
    render(StarredPage)
    expect(await screen.findByText('Just this note')).toBeInTheDocument()
    expect(screen.queryByText('Blank note item')).toBeInTheDocument()
    const blankTitle = screen.getByText('Blank note item')
    expect(blankTitle.closest('a')?.querySelector('.entry-notes')).toBeNull()
  })

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
