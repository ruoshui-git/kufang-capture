/** Exact decimal addition using strings only. Invalid decimal inputs are treated as zero. */
export function addDecimals(left: string, right: string): string {
  const parse = (value: string) => {
    const match = value.trim().match(/^([+-]?)(\d+)(?:\.(\d*))?$/)
    if (!match) return { sign: 1n, digits: 0n, scale: 0 }
    const scale = match[3]?.length ?? 0
    const magnitude = BigInt(`${match[2]}${match[3] ?? ''}`)
    return { sign: match[1] === '-' ? -1n : 1n, digits: magnitude, scale }
  }
  const a = parse(left)
  const b = parse(right)
  const scale = Math.max(a.scale, b.scale)
  const sum =
    a.sign * a.digits * 10n ** BigInt(scale - a.scale) + b.sign * b.digits * 10n ** BigInt(scale - b.scale)
  if (sum === 0n) return '0'
  const negative = sum < 0n
  let digits = (negative ? -sum : sum).toString().padStart(scale + 1, '0')
  if (scale > 0) {
    const split = digits.length - scale
    digits = `${digits.slice(0, split)}.${digits.slice(split)}`.replace(/\.?0+$/, '')
  }
  return `${negative ? '-' : ''}${digits}`
}

export function normalizeUnit(unit: string): string {
  return unit.trim().toLocaleLowerCase()
}

export function isIncomplete(
  entry: { quantity: string | null; review_status: string },
  hasPhotos: boolean,
): boolean {
  return (
    !hasPhotos ||
    entry.quantity === null ||
    entry.quantity.trim() === '' ||
    entry.review_status === 'needs_review'
  )
}
