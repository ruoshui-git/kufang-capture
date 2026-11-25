import { repo } from '../db'
import type { AuthClient, PeopleClient, ServerClient } from './api'
import {
  AccountRequestError,
  accountGate,
  accountUnavailable,
  requestHeaders,
  responseCode,
  sessionChangeKey,
} from './binding'

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

const peopleErrors: Record<string, string> = {
  owner_required: 'Sign in as the owner to manage People.',
  person_not_found: 'This person could not be found. Reopen People to refresh the list.',
  name_taken: 'Someone already has that name.',
  invalid_name: 'Enter a name with 1 to 40 characters.',
  person_disabled: 'Enable this person before making a sign-in code.',
}

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
      throw new Error("Couldn't reach the server. Check your connection and try again.")
    }
    if (response.status === 401)
      throw new Error(
        kind === 'login'
          ? 'Password is incorrect.'
          : 'This code is invalid, expired or already used. Ask for a new code.',
      )
    if (response.status === 429) {
      const wait = Number(response.headers.get('Retry-After') ?? '60')
      const minutes = Math.max(1, Math.ceil(wait / 60))
      throw new Error(`Too many attempts. Try again in ${minutes} ${minutes === 1 ? 'minute' : 'minutes'}.`)
    }
    if (response.status === 503 && (await responseCode(response)) === 'account_unavailable')
      throw new AccountRequestError(accountUnavailable)
    if (!response.ok) throw new Error(`Sign-in failed (${response.status}). Try again.`)
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
      throw new Error((code && peopleErrors[code]) || 'Could not update People. Try again.')
    }
    return response.json()
  }

  async function serverRequest(url: string, init?: RequestInit) {
    const response = await accountGate.request(fetcher, url, init)
    if (!response.ok) {
      const data = (await response.json().catch(() => null)) as { message?: string } | null
      throw new Error(data?.message ?? `Request failed (${response.status}).`)
    }
    return response
  }

  return {
    authClient: {
      session: async () => {
        const response = await requestAuth('/api/auth/session')
        if (response.status === 503 && (await responseCode(response)) === 'account_unavailable')
          throw new AccountRequestError(accountUnavailable)
        if (!response.ok) throw new Error(`Session request failed (${response.status}).`)
        return response.json()
      },
      login: (password) => signIn('login', { password }),
      join: (code) => signIn('join', { code }),
      logout: async () => {
        const response = await requestAuth('/api/auth/logout', { method: 'POST' })
        if (!response.ok) throw new Error('Could not sign out.')
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
