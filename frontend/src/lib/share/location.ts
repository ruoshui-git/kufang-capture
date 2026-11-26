import { SHARE_TOKEN_RE, type ShareLocation } from './contract'

export function validShareToken(token: string): boolean {
  return token.length === 43 && SHARE_TOKEN_RE.test(token)
}

export function parseShareLocation(fragment: string): ShareLocation | null {
  if (!fragment.startsWith('#')) return null
  const [token, segment, number, ...rest] = fragment.slice(1).split('/')
  if (!token || !validShareToken(token)) return null
  if (segment === undefined) return { token, sequence: null }
  if (segment !== 'e' || !number || /\D/.test(number) || rest.length > 0) return null
  const sequence = Number(number)
  return Number.isSafeInteger(sequence) && sequence > 0 ? { token, sequence } : null
}

export function sharePath(token: string, sequence?: number): string {
  return sequence === undefined ? `/share#${token}` : `/share#${token}/e/${sequence}`
}
