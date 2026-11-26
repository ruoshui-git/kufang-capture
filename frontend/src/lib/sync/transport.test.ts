import { afterEach, expect, it, vi } from 'vitest'
import { SyncWatchdogError, withRequestTimeout } from './transport'

afterEach(() => {
  vi.useRealTimers()
})

it('includes the response body in the request deadline', async () => {
  vi.useFakeTimers()
  let stream!: ReadableStreamDefaultController<Uint8Array>
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      stream = controller
    },
  })
  const fetcher = vi.fn(async () => new Response(body))
  const fetchWithTimeout = withRequestTimeout(fetcher, 500)
  const timedOut = expect(fetchWithTimeout('/api/sync/changes')).rejects.toBeInstanceOf(SyncWatchdogError)
  try {
    await vi.advanceTimersByTimeAsync(500)
    await timedOut
    expect(vi.getTimerCount()).toBe(0)
  } finally {
    stream.close()
  }
})

it('forwards a cycle abort and removes the deadline even if the fetcher ignores abort', async () => {
  vi.useFakeTimers()
  const cycle = new AbortController()
  const fetcher = vi.fn<typeof fetch>(() => new Promise(() => {}))
  const stopped = withRequestTimeout(fetcher, 500)('/api/auth/session', { signal: cycle.signal })
  cycle.abort()
  await expect(stopped).rejects.toBe(cycle.signal.reason)
  expect(fetcher.mock.calls[0]?.[1]?.signal?.aborted).toBe(true)
  expect(vi.getTimerCount()).toBe(0)
})
