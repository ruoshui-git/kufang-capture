import { m } from '../paraglide/messages.js'
import { repo } from '../db'
import { getLocale } from '../paraglide/runtime.js'
import type { AuthClient, PeopleClient, ServerClient } from './api'
import { AccountRequestError, accountGate, requestHeaders, responseCode, sessionChangeKey } from './binding'

const publishSession = (type: 'authenticated' | 'signed-out') => {
  if (typeof window === 'undefined') return
  window.dispatchEvent(new Event(`capture:${type}`))
  try {
    // Tabs share the cookie and binding. Send a change signal without storing account information.
    window.localStorage.setItem(sessionChangeKey, crypto.randomUUID())
  } catch {
    // Session checks still protect requests in browsers without localStorage.
  }
}

const peopleErrors = new Map<string, () => string>([
  ['owner_required', m.core_people_owner_required],
  ['person_not_found', m.core_people_not_found],
  ['name_taken', m.core_people_name_taken],
  ['invalid_name', m.core_people_invalid_name],
  ['person_disabled', m.core_people_person_disabled],
])

const serverErrors = new Map<string, () => string>([
  ['collection_not_found', m.core_collection_not_found],
  ['confirmation_name_mismatch', m.core_confirmation_name_mismatch],
  ['csrf_failed', m.core_request_verification_failed],
])

export function createClients(fetcher: typeof fetch): {
  authClient: AuthClient
  serverClient: ServerClient
  peopleClient: PeopleClient
} {
  const requestAuth = (url: string, init: RequestInit = {}) =>
    fetcher(url, {
      ...init,
      credentials: 'same-origin',
      cache: 'no-store',
      headers: requestHeaders(init.method ?? 'GET', init.headers),
    })

  async function signIn(kind: 'login' | 'join', body: object) {
    let response: Response
    try {
      response = await requestAuth(`/api/auth/${kind}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
    } catch {
      throw new Error(m.core_connection_retry())
    }
    if (response.status === 401)
      throw new Error(kind === 'login' ? m.core_sign_in_bad_password() : m.core_sign_in_bad_join_code())
    if (response.status === 429) {
      const wait = Number(response.headers.get('Retry-After') ?? '60')
      const minutes = Math.max(1, Math.ceil(wait / 60))
      throw new Error(m.core_sign_in_rate_limit({ count: minutes }))
    }
    if (response.status === 503 && (await responseCode(response)) === 'account_unavailable')
      throw new AccountRequestError(m.core_account_unavailable())
    if (!response.ok) throw new Error(m.core_sign_in_request_failed({ status: response.status }))
    accountGate.reset()
    try {
      const access = await accountGate.check(fetcher)
      if (kind === 'join' && access.kind === 'ready') void repo.requestPersistentStorage()
    } finally {
      publishSession('authenticated')
    }
  }

  async function peopleRequest(path: string, method = 'GET', body?: object) {
    const response = await accountGate.request(fetcher, path, {
      method,
      ...(body && { body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } }),
    })
    if (!response.ok) {
      const code = await responseCode(response)
      throw new Error((code && peopleErrors.get(code)?.()) || m.core_people_update_failed())
    }
    return response.json()
  }

  async function serverRequest(url: string, init?: RequestInit) {
    const response = await accountGate.request(fetcher, url, init)
    if (!response.ok) {
      const data = (await response.json().catch(() => null)) as { detail?: string; message?: string } | null
      const fallback = m.core_request_failed({ status: response.status })
      if (getLocale() === 'en') throw new Error(data?.message ?? fallback)
      const translate = data?.detail ? serverErrors.get(data.detail) : undefined
      throw new Error(translate?.() ?? fallback)
    }
    return response
  }

  return {
    authClient: {
      session: async () => {
        const response = await requestAuth('/api/auth/session')
        if (response.status === 503 && (await responseCode(response)) === 'account_unavailable')
          throw new AccountRequestError(m.core_account_unavailable())
        if (!response.ok) throw new Error(m.core_session_request_failed({ status: response.status }))
        return response.json()
      },
      login: (password) => signIn('login', { password }),
      join: (code) => signIn('join', { code }),
      logout: async () => {
        const response = await requestAuth('/api/auth/logout', { method: 'POST' })
        if (!response.ok) throw new Error(m.core_sign_out_failed())
        accountGate.reset(true)
        publishSession('signed-out')
      },
      switchAccount: async () => {
        const user = accountGate.requireReady(await accountGate.check(fetcher, undefined, true))
        if (!user.is_owner) void repo.requestPersistentStorage()
        publishSession('authenticated')
      },
    },
    serverClient: {
      listCollections: async () => (await serverRequest('/api/collections')).json(),
      exportZip: (scope, opts = {}) =>
        serverRequest(
          `${scope === 'all' ? '/api/exports/all.zip' : `/api/exports/collections/${encodeURIComponent(scope.collectionId)}.zip`}?include_trash=${opts.includeTrash ? '1' : '0'}`,
        ),
      removeServerCopy: async (collectionId, confirmName) => {
        await serverRequest(`/api/collections/${encodeURIComponent(collectionId)}/server-copy`, {
          method: 'DELETE',
          headers: { 'X-Confirm-Name': confirmName },
        })
      },
    },
    peopleClient: {
      list: () => peopleRequest('/api/people'),
      create: (name) => peopleRequest('/api/people', 'POST', { name }),
      update: (id, patch) => peopleRequest(`/api/people/${encodeURIComponent(id)}`, 'PATCH', patch),
      issueCode: (id) => peopleRequest(`/api/people/${encodeURIComponent(id)}/code`, 'POST'),
    },
  }
}

export const { authClient, serverClient, peopleClient } = createClients((input, init) => fetch(input, init))
