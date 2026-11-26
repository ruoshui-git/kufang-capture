export class SyncWatchdogError extends TypeError {}

export interface SyncTimeouts {
  requestMs: number
  uploadStallMs: number
  uploadResponseMs: number
}

export const defaultSyncTimeouts: SyncTimeouts = {
  requestMs: 30_000,
  uploadStallMs: 45_000,
  uploadResponseMs: 60_000,
}

export function withRequestTimeout(fetcher: typeof fetch, timeoutMs: number): typeof fetch {
  return async (input, init) => {
    const signal = init?.signal
    signal?.throwIfAborted()
    const request = new AbortController()
    let onAbort!: () => void
    let timer: ReturnType<typeof setTimeout> | undefined
    const interrupted = new Promise<never>((_, reject) => {
      onAbort = () => {
        reject(signal?.reason)
        request.abort()
      }
      signal?.addEventListener('abort', onAbort, { once: true })
      timer = setTimeout(() => {
        reject(new SyncWatchdogError())
        request.abort()
      }, timeoutMs)
    })
    try {
      const response = async () => {
        const result = await fetcher(input, { ...init, signal: request.signal })
        // Fetch resolves at the headers. Keep the watchdog active through the JSON body too.
        if (result.body) await result.clone().arrayBuffer()
        return result
      }
      return await Promise.race([response(), interrupted])
    } finally {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
    }
  }
}

export function uploadBlob(
  xhr: XMLHttpRequest,
  url: string,
  headers: Headers,
  blob: Blob,
  signal: AbortSignal,
  timeouts: SyncTimeouts,
  onProgress?: (sent: number) => void,
): Promise<Response> {
  return new Promise((resolve, reject) => {
    signal.throwIfAborted()
    let timer: ReturnType<typeof setTimeout> | undefined
    const cleanup = () => {
      clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
      xhr.upload.onprogress = xhr.upload.onload = null
      xhr.onload = xhr.onerror = xhr.onabort = null
    }
    const fail = (error: unknown) => {
      cleanup()
      reject(error)
    }
    const onAbort = () => {
      fail(signal.reason)
      xhr.abort()
    }
    const arm = (ms: number) => {
      clearTimeout(timer)
      timer = setTimeout(() => {
        fail(new SyncWatchdogError())
        xhr.abort()
      }, ms)
    }
    xhr.upload.onprogress = ({ loaded }) => {
      arm(timeouts.uploadStallMs)
      onProgress?.(loaded)
    }
    xhr.upload.onload = () => {
      arm(timeouts.uploadResponseMs)
      onProgress?.(blob.size)
    }
    xhr.onerror = xhr.onabort = () => fail(new TypeError())
    xhr.onload = () => {
      cleanup()
      try {
        const responseHeaders = new Headers()
        for (const line of xhr.getAllResponseHeaders().trim().split(/\r?\n/)) {
          const separator = line.indexOf(':')
          if (separator !== -1) responseHeaders.append(line.slice(0, separator), line.slice(separator + 1))
        }
        const body = [204, 205, 304].includes(xhr.status) ? null : xhr.responseText
        resolve(
          new Response(body, { status: xhr.status, statusText: xhr.statusText, headers: responseHeaders }),
        )
      } catch (error) {
        reject(error)
      }
    }
    try {
      xhr.open('PUT', url)
      headers.forEach((value, name) => xhr.setRequestHeader(name, value))
      signal.addEventListener('abort', onAbort, { once: true })
      arm(timeouts.uploadStallMs)
      xhr.send(blob)
    } catch (error) {
      fail(error)
    }
  })
}
