import { fetchSharedPhoto } from './api'

const maxConcurrent = 4
let active = 0
const pending = new Set<() => void>()

function drain() {
  while (active < maxConcurrent && pending.size) {
    const job = pending.values().next().value!
    pending.delete(job)
    job()
  }
}

export function loadSharedThumbnail(token: string, id: string, signal: AbortSignal): Promise<Blob> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason)
      return
    }
    function cancelPending() {
      pending.delete(start)
      reject(signal.reason)
    }
    function start() {
      signal.removeEventListener('abort', cancelPending)
      active++
      void fetchSharedPhoto(token, id, 'thumbnail', signal)
        .then(resolve, reject)
        .finally(() => {
          active--
          drain()
        })
    }
    signal.addEventListener('abort', cancelPending, { once: true })
    pending.add(start)
    drain()
  })
}
