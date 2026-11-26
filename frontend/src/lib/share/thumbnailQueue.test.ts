import { afterEach, expect, it, vi } from 'vitest'
import { loadSharedThumbnail } from './thumbnailQueue'

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

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

it('starts the next thumbnail after all four active requests time out', async () => {
  vi.useFakeTimers()
  const mock = vi.fn((path: string) =>
    path.endsWith('/next/thumbnail') ? Promise.resolve(new Response('next image')) : new Promise(() => {}),
  )
  vi.stubGlobal('fetch', mock)
  const { signal } = new AbortController()
  const token = 't'.repeat(43)
  const stalled = Array.from({ length: 4 }, (_, id) =>
    expect(loadSharedThumbnail(token, `photo-${id}`, signal)).rejects.toMatchObject({ code: 'network' }),
  )
  const next = loadSharedThumbnail(token, 'next', signal)
  expect(mock).toHaveBeenCalledTimes(4)

  await vi.advanceTimersByTimeAsync(30_000)

  await Promise.all(stalled)
  expect(mock).toHaveBeenCalledTimes(5)
  await expect((await next).text()).resolves.toBe('next image')
})
