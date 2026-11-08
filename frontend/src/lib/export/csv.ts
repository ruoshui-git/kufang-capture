export function writeCsv(headers: string[], rows: Array<Record<string, unknown>>): Uint8Array {
  const quote = (value: unknown): string => {
    if (value === null || value === undefined) return ''
    const text = typeof value === 'boolean' ? String(value) : String(value)
    return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text
  }
  const lines = [
    headers.map(quote).join(','),
    ...rows.map((row) => headers.map((key) => quote(row[key])).join(',')),
  ]
  return new TextEncoder().encode(`\uFEFF${lines.join('\r\n')}\r\n`)
}
