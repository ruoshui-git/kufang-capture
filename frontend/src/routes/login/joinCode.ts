export function normalizeJoinCode(input: string): string {
  if (input.length > 128) return ''
  // oxlint-disable-next-line no-control-regex -- strips ASCII separator controls from pasted codes
  const compact = input.replace(/[\p{White_Space}\p{Dash_Punctuation}\x1c-\x1f]/gu, '')
  if (!/^[\da-z]{8}$/i.test(compact)) return ''
  const code = compact.toUpperCase().replaceAll('O', '0').replace(/[IL]/g, '1')
  return /^[0-9A-HJKMNP-TV-Z]{8}$/.test(code) ? `${code.slice(0, 4)}-${code.slice(4)}` : ''
}

export function isInAppBrowser(userAgent: string): boolean {
  return /MicroMessenger|\bQQ\/|AlipayClient/i.test(userAgent)
}

export function joinCodeFromHash(hash: string): string {
  try {
    return normalizeJoinCode(decodeURIComponent(hash.slice(1)))
  } catch {
    return ''
  }
}
