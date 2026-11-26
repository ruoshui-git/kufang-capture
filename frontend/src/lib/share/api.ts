import { SHARE_HEADER } from './contract'
import { validShareToken } from './location'
import type { CreateShareRequest, SharedCollection, ShareLink } from './contract'

type ShareErrorCode =
  | 'share_required'
  | 'share_not_found'
  | 'share_expired'
  | 'too_many_attempts'
  | 'photo_not_found'
  | 'photo_not_stored'
  | 'collection_not_found'
  | 'too_many_shares'
  | 'invalid_label'
  | 'sign_in'
  | 'local_only'
  | 'network'
  | 'request_failed'

export class ShareError extends Error {
  readonly code: ShareErrorCode

  constructor(code: ShareErrorCode) {
    super(code)
    this.code = code
  }
}

async function failure(response: Response): Promise<never> {
  const body = (await response.json().catch(() => null)) as { code?: string; detail?: string } | null
  const code = body?.code ?? body?.detail
  switch (code) {
    case 'share_required':
    case 'share_not_found':
    case 'share_expired':
    case 'too_many_attempts':
    case 'photo_not_found':
    case 'photo_not_stored':
    case 'collection_not_found':
    case 'too_many_shares':
    case 'invalid_label':
      throw new ShareError(code)
    default:
      throw new ShareError('request_failed')
  }
}

async function withDeadline<T>(
  timeoutMs: number,
  run: (signal: AbortSignal) => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  signal?.throwIfAborted()
  const controller = new AbortController()
  const cancel = () => controller.abort(signal?.reason)
  const interrupted = new Promise<never>((_, reject) => {
    controller.signal.addEventListener('abort', () => reject(controller.signal.reason), { once: true })
  })
  signal?.addEventListener('abort', cancel, { once: true })
  const timer = setTimeout(() => controller.abort(new ShareError('network')), timeoutMs)
  try {
    return await Promise.race([run(controller.signal), interrupted])
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', cancel)
  }
}

async function publicRequest<T>(
  token: string,
  path: string,
  timeoutMs: number,
  read: (response: Response) => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  if (!validShareToken(token)) throw new ShareError('share_required')
  try {
    return await withDeadline(
      timeoutMs,
      async (requestSignal) => {
        const response = await fetch(path, {
          headers: { [SHARE_HEADER]: token },
          cache: 'no-store',
          credentials: 'omit',
          redirect: 'error',
          referrerPolicy: 'no-referrer',
          signal: requestSignal,
        })
        requestSignal.throwIfAborted()
        return response.ok ? read(response) : failure(response)
      },
      signal,
    )
  } catch (error) {
    signal?.throwIfAborted()
    if (error instanceof ShareError) throw error
    throw new ShareError('network')
  }
}

export function fetchShared(token: string, signal?: AbortSignal): Promise<SharedCollection> {
  return publicRequest(token, '/api/share', 20_000, (response) => response.json(), signal)
}

export function fetchSharedPhoto(
  token: string,
  photoId: string,
  kind: 'thumbnail' | 'original',
  signal?: AbortSignal,
): Promise<Blob> {
  return publicRequest(
    token,
    `/api/share/photos/${encodeURIComponent(photoId)}/${kind}`,
    kind === 'thumbnail' ? 30_000 : 120_000,
    (response) => response.blob(),
    signal,
  )
}

async function ownerRequest(path: string, init: RequestInit, collectionId?: string) {
  // Only owner requests access account binding and IndexedDB.
  const { accountGate, AccountRequestError } = await import('$lib/sync/binding')
  const { getCaptureDb } = await import('$lib/db')
  const db = collectionId ? getCaptureDb() : undefined
  const requireSynced = async () => {
    if (db && collectionId && (await db.collections.get(collectionId))?.storage_mode !== 'synced')
      throw new ShareError('local_only')
  }
  try {
    init.signal?.throwIfAborted()
    await requireSynced()
    const response = await accountGate.request(
      async (input, options) => {
        if (!db || input !== path) return fetch(input, options)
        // Keep storage mode stable through dispatch, including a mode change in another tab.
        const pending = await db.transaction('r', db.collections, async () => {
          await requireSynced()
          options?.signal?.throwIfAborted()
          const response = fetch(input, options)
          void response.catch(() => {})
          return { response }
        })
        return pending.response
      },
      path,
      init,
    )
    if (!response.ok) return await failure(response)
    return response
  } catch (error) {
    init.signal?.throwIfAborted()
    if (error instanceof AccountRequestError && error.code === 'sign_in') throw new ShareError('sign_in')
    if (error instanceof TypeError) throw new ShareError('network')
    throw error
  } finally {
    db?.close()
  }
}

export async function listShares(collectionId: string, signal?: AbortSignal): Promise<ShareLink[]> {
  const response = await ownerRequest(
    `/api/shares?collection_id=${encodeURIComponent(collectionId)}`,
    { signal },
    collectionId,
  )
  const body: { shares: ShareLink[] } = await response.json()
  return body.shares
}

/** Every live link of the signed-in account, for server copies listed by the server itself. */
export async function listServerShares(signal?: AbortSignal): Promise<ShareLink[]> {
  const response = await ownerRequest('/api/shares', { signal })
  const body: { shares: ShareLink[] } = await response.json()
  return body.shares
}

export async function createShare(request: CreateShareRequest, signal?: AbortSignal): Promise<ShareLink> {
  const response = await ownerRequest(
    '/api/shares',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request),
      signal,
    },
    request.collection_id,
  )
  return response.json()
}

export async function revokeShare(id: string, signal?: AbortSignal, collectionId?: string): Promise<void> {
  await ownerRequest(`/api/shares/${encodeURIComponent(id)}`, { method: 'DELETE', signal }, collectionId)
}

export async function revokeCollectionShares(collectionId: string): Promise<void> {
  await withDeadline(8_000, async (signal) => {
    const links = await listShares(collectionId, signal)
    signal.throwIfAborted()
    const results = await Promise.allSettled(links.map(({ id }) => revokeShare(id, signal, collectionId)))
    const failure = results.find((result) => result.status === 'rejected')
    if (failure) throw failure.reason
  })
}
