import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Blob as NodeBlob } from 'node:buffer'
import PhotoViewer from './PhotoViewer.svelte'

vi.mock('$lib/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('$lib/db')>()
  return {
    repo: actual.createRepo({
      databaseName: `viewer-component-${Date.now()}`,
      imageProcessor: async () => {
        throw new Error('thumbnail unavailable')
      },
    }),
  }
})
const { repo } = await import('$lib/db')
afterEach(cleanup)

describe('photo viewer', () => {
  const createUrl = URL.createObjectURL
  const revokeUrl = URL.revokeObjectURL
  afterEach(() => {
    URL.createObjectURL = createUrl
    URL.revokeObjectURL = revokeUrl
  })
  it('opens at the requested photo, moves with arrow keys, and closes with Escape', async () => {
    URL.createObjectURL = vi.fn(() => 'blob:test')
    const collection = await repo.createCollection({ name: 'Viewer room', storage_mode: 'local_only' })
    const entry = await repo.createEntry(collection.id)
    const photos = await repo.addPhotos(entry.id, [
      { blob: new NodeBlob(['photo 1'], { type: 'image/jpeg' }) as Blob, source: 'native_camera' },
      { blob: new NodeBlob(['photo 2'], { type: 'image/jpeg' }) as Blob, source: 'photo_library' },
    ])
    render(PhotoViewer, { props: { open: true, entryId: entry.id, startPhotoId: photos[1]!.id } })
    const dialog = await screen.findByRole('dialog', { name: 'Photo viewer' })
    await waitFor(() => expect(dialog.textContent).toContain('2 of 2'))
    await fireEvent.keyDown(dialog, { key: 'ArrowLeft' })
    expect(dialog.textContent).toContain('1 of 2')
    await fireEvent.keyDown(dialog, { key: 'Escape' })
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: 'Photo viewer' })).not.toBeInTheDocument(),
    )
  })
  it('loads a shared original, releases it on slide change and skips an unuploaded photo', async () => {
    URL.createObjectURL = vi.fn(() => 'blob:shared')
    URL.revokeObjectURL = vi.fn()
    const loader = vi.fn().mockResolvedValue(new Blob(['photo']))
    const watchLocal = vi.spyOn(repo, 'watchPhotos')
    const opener = document.createElement('button')
    document.body.append(opener)
    opener.focus()
    try {
      const info = { width: 40, height: 20, byte_size: 200 }
      render(PhotoViewer, {
        props: {
          open: true,
          photoSource: {
            photos: [
              { ...info, id: 'stored', caption: 'Shared photo', stored: true },
              { ...info, id: 'pending', caption: '', stored: false },
            ],
            loadOriginal: loader,
          },
        },
      })
      expect(await screen.findByRole('img', { name: 'Shared photo' })).toHaveAttribute('src', 'blob:shared')
      const dialog = screen.getByRole('dialog', { name: 'Photo viewer' })
      await fireEvent.keyDown(dialog, { key: 'ArrowRight' })
      expect(await screen.findByText('Not uploaded yet')).toBeInTheDocument()
      expect(loader).toHaveBeenCalledExactlyOnceWith('stored', expect.any(AbortSignal))
      expect(URL.revokeObjectURL).toHaveBeenCalledExactlyOnceWith('blob:shared')
      expect(watchLocal).not.toHaveBeenCalled()
      await fireEvent.keyDown(dialog, { key: 'Escape' })
      await waitFor(() => expect(opener).toHaveFocus())
    } finally {
      opener.remove()
    }
  })
})
