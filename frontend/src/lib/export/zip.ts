export interface ZipMember {
  name: string
  data: Blob | Uint8Array
  crc32: number
  size: number
  mtime: Date | string
}

export interface ZipOptions {
  sizeLimit?: number
  entryLimit?: number
}

const encoder = new TextEncoder()
const u16 = (v: number) => [v & 255, (v >>> 8) & 255]
const u32 = (v: number) => [v & 255, (v >>> 8) & 255, (v >>> 16) & 255, (v >>> 24) & 255]
const u64 = (v: number) => [...u32(v), ...u32(Math.floor(v / 0x100000000))]
function dosDate(dateLike: Date | string): [number, number] {
  const d = typeof dateLike === 'string' ? new Date(dateLike) : dateLike
  const year = Math.max(1980, d.getUTCFullYear())
  return [
    (d.getUTCHours() << 11) | (d.getUTCMinutes() << 5) | (d.getUTCSeconds() >>> 1),
    ((year - 1980) << 9) | ((d.getUTCMonth() + 1) << 5) | d.getUTCDate(),
  ]
}

export function createZip(members: ZipMember[], options: ZipOptions = {}): Blob {
  const max = options.sizeLimit ?? 0xffffffff
  const maxEntries = options.entryLimit ?? 0xffff
  const parts: BlobPart[] = []
  const central: Uint8Array[] = []
  let offset = 0
  let any64 = members.length > maxEntries
  for (const member of members) {
    const name = encoder.encode(member.name)
    const [time, date] = dosDate(member.mtime)
    const zip64 = member.size > max || offset > max
    any64 ||= zip64
    const extra = zip64
      ? new Uint8Array([1, 0, 16, 0, ...u64(member.size), ...u64(member.size)])
      : new Uint8Array()
    const size32 = zip64 ? 0xffffffff : member.size
    const localHeader = new Uint8Array([
      ...u32(0x04034b50),
      ...u16(zip64 ? 45 : 20),
      ...u16(0x0800),
      ...u16(0),
      ...u16(time),
      ...u16(date),
      ...u32(member.crc32),
      ...u32(size32),
      ...u32(size32),
      ...u16(name.length),
      ...u16(extra.length),
      ...name,
      ...extra,
    ])
    parts.push(localHeader, member.data)
    const centralExtra = zip64
      ? new Uint8Array([1, 0, 24, 0, ...u64(member.size), ...u64(member.size), ...u64(offset)])
      : new Uint8Array()
    const centralHeader = new Uint8Array([
      ...u32(0x02014b50),
      ...u16(45),
      ...u16(zip64 ? 45 : 20),
      ...u16(0x0800),
      ...u16(0),
      ...u16(time),
      ...u16(date),
      ...u32(member.crc32),
      ...u32(size32),
      ...u32(size32),
      ...u16(name.length),
      ...u16(centralExtra.length),
      ...u16(0),
      ...u16(0),
      ...u16(0),
      ...u32(0),
      ...u32(zip64 ? 0xffffffff : offset),
      ...name,
      ...centralExtra,
    ])
    central.push(centralHeader)
    offset += localHeader.byteLength + member.size
  }
  const centralOffset = offset
  for (const record of central) {
    parts.push(record)
    offset += record.byteLength
  }
  const centralSize = offset - centralOffset
  any64 ||= centralOffset > max || centralSize > max
  if (any64) {
    const zip64Offset = offset
    parts.push(
      new Uint8Array([
        ...u32(0x06064b50),
        ...u64(44),
        ...u16(45),
        ...u16(45),
        ...u32(0),
        ...u32(0),
        ...u64(members.length),
        ...u64(members.length),
        ...u64(centralSize),
        ...u64(centralOffset),
        ...u32(0x07064b50),
        ...u32(0),
        ...u64(zip64Offset),
        ...u32(1),
      ]),
    )
    parts.push(
      new Uint8Array([
        ...u32(0x06054b50),
        ...u16(0),
        ...u16(0),
        ...u16(0xffff),
        ...u16(0xffff),
        ...u32(0xffffffff),
        ...u32(0xffffffff),
        ...u16(0),
      ]),
    )
  } else {
    parts.push(
      new Uint8Array([
        ...u32(0x06054b50),
        ...u16(0),
        ...u16(0),
        ...u16(members.length),
        ...u16(members.length),
        ...u32(centralSize),
        ...u32(centralOffset),
        ...u16(0),
      ]),
    )
  }
  return new Blob(parts, { type: 'application/zip' })
}
