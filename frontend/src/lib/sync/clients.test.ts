import { afterEach, describe, expect, it } from 'vitest'
import { setLocale } from '../paraglide/runtime.js'
import { AccountGate, accountDisplayName } from './binding'
import { createClients } from './clients'

const owner = { id: 'owner', name: 'Owner', is_owner: true }

afterEach(() => {
  void setLocale('en', { reload: false })
})

describe('server copy removal', () => {
  it('sends a Chinese collection name as a URL-encoded confirmation header', async () => {
    const requests: Request[] = []
    const { serverClient } = createClients(async (input, init) => {
      const request = new Request(new URL(String(input), 'http://capture.test'), init)
      requests.push(request)
      if (request.url.endsWith('/api/auth/session'))
        return Response.json({ authenticated: true, user: owner, expires_at: null })
      return new Response(null, { status: 204 })
    })
    await serverClient.removeServerCopy('c1', '二号库房 A04')
    const removal = requests.find((request) => request.method === 'DELETE')
    expect(removal?.headers.get('X-Confirm-Name')).toBe(encodeURIComponent('二号库房 A04'))
    expect(decodeURIComponent(removal!.headers.get('X-Confirm-Name')!)).toBe('二号库房 A04')
  })
})

describe('bound account names', () => {
  it('shows only the built-in owner name in the UI language', () => {
    void setLocale('zh-CN', { reload: false })
    expect(accountDisplayName('owner', 'Owner')).toBe('所有者')
    expect(accountDisplayName('helper', 'Owner')).toBe('Owner')
    expect(accountDisplayName('owner', 'Mina')).toBe('Mina')
    void setLocale('en', { reload: false })
    expect(accountDisplayName('owner', 'Owner')).toBe('Owner')
  })

  it('names the built-in owner in Chinese when a helper session meets an owner-bound device', async () => {
    void setLocale('zh-CN', { reload: false })
    const gate = new AccountGate('test-clients-owner-name')
    await gate.check(async () => Response.json({ authenticated: true, user: owner, expires_at: null }))
    const helper = { id: 'helper', name: 'Mina', is_owner: false }
    await gate.check(async () => Response.json({ authenticated: true, user: helper, expires_at: null }))
    expect(gate.current).toMatchObject({ kind: 'blocked', name: '所有者', user: helper })
  })
})
