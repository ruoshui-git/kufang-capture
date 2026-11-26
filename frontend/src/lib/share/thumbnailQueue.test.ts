import { afterEach, expect, it, vi } from 'vitest'
import { loadSharedThumbnail } from './thumbnailQueue'

afterEach(() => vi.unstubAllGlobals())

it('caps thumbnail requests at four and drops queued work that leaves view', async () => {
  const finish: (() => void)[] = []
  const mock = vi.fn(
    () => new Promise<Response>((resolve) => finish.push(() => resolve(new Response('image')))),
  )
  vi.stubGlobal('fetch', mock)
  const visible = new AbortController()
  const cancelled = new AbortController()
  const token = 't'.repeat(43)
  const active = Array.from({ length: 4 }, (_, id) =>
    loadSharedThumbnail(token, `photo-${id}`, visible.signal),
  )
  const offscreen = loadSharedThumbnail(token, 'offscreen', cancelled.signal)
  const next = loadSharedThumbnail(token, 'next', visible.signal)
  expect(mock).toHaveBeenCalledTimes(4)
  cancelled.abort()
  await expect(offscreen).rejects.toMatchObject({ name: 'AbortError' })

  finish.shift()?.()
  await vi.waitFor(() => expect(mock).toHaveBeenCalledTimes(5))
  expect(mock).toHaveBeenLastCalledWith('/api/share/photos/next/thumbnail', expect.anything())
  for (const complete of finish) complete()
  await Promise.all([...active, next])
})
