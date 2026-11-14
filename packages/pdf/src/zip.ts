// NOTE: A minimal zip writer for "Download all" (D4, stage 8). Entries are
// stored, not compressed: a PDF is already compressed, and a store-only writer
// is about sixty lines and a dependency fewer. It writes the local headers,
// the central directory and the end record (no zip64: a report's PDFs are a
// few megabytes). Names are UTF-8. The time stamp is a parameter, so the same
// input gives the same bytes.

export type ZipEntry = Readonly<{ name: string; data: Uint8Array }>

const TABLE: ReadonlyArray<number> = Array.from({ length: 256 }, (_, n) => {
  let value = n
  for (let bit = 0; bit < 8; bit += 1) {
    value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
  }
  return value >>> 0
})

export const crc32 = (data: Uint8Array): number => {
  let crc = 0xffffffff
  for (const byte of data) {
    crc = (TABLE[(crc ^ byte) & 0xff] ?? 0) ^ (crc >>> 8)
  }
  return (crc ^ 0xffffffff) >>> 0
}

const dosTime = (date: Date): readonly [number, number] => {
  const year = Math.max(1980, date.getUTCFullYear())
  return [
    (date.getUTCHours() << 11) |
      (date.getUTCMinutes() << 5) |
      (date.getUTCSeconds() >> 1),
    ((year - 1980) << 9) | ((date.getUTCMonth() + 1) << 5) | date.getUTCDate(),
  ]
}

export const zipStore = (
  entries: ReadonlyArray<ZipEntry>,
  modified: Date,
): Uint8Array => {
  const encoder = new TextEncoder()
  const [time, day] = dosTime(modified)
  const chunks: Array<Uint8Array> = []
  const central: Array<Uint8Array> = []
  let offset = 0
  const push = (bytes: Uint8Array): void => {
    chunks.push(bytes)
    offset += bytes.length
  }
  for (const entry of entries) {
    const name = encoder.encode(entry.name)
    const crc = crc32(entry.data)
    const local = new DataView(new ArrayBuffer(30))
    local.setUint32(0, 0x04034b50, true)
    local.setUint16(4, 20, true)
    local.setUint16(6, 0x0800, true)
    local.setUint16(8, 0, true)
    local.setUint16(10, time, true)
    local.setUint16(12, day, true)
    local.setUint32(14, crc, true)
    local.setUint32(18, entry.data.length, true)
    local.setUint32(22, entry.data.length, true)
    local.setUint16(26, name.length, true)
    local.setUint16(28, 0, true)
    const head = new DataView(new ArrayBuffer(46))
    head.setUint32(0, 0x02014b50, true)
    head.setUint16(4, 20, true)
    head.setUint16(6, 20, true)
    head.setUint16(8, 0x0800, true)
    head.setUint16(10, 0, true)
    head.setUint16(12, time, true)
    head.setUint16(14, day, true)
    head.setUint32(16, crc, true)
    head.setUint32(20, entry.data.length, true)
    head.setUint32(24, entry.data.length, true)
    head.setUint16(28, name.length, true)
    head.setUint32(42, offset, true)
    central.push(new Uint8Array(head.buffer), name)
    push(new Uint8Array(local.buffer))
    push(name)
    push(entry.data)
  }
  const start = offset
  central.forEach(push)
  const end = new DataView(new ArrayBuffer(22))
  end.setUint32(0, 0x06054b50, true)
  end.setUint16(8, entries.length, true)
  end.setUint16(10, entries.length, true)
  end.setUint32(12, offset - start, true)
  end.setUint32(16, start, true)
  push(new Uint8Array(end.buffer))
  const out = new Uint8Array(offset)
  let at = 0
  for (const chunk of chunks) {
    out.set(chunk, at)
    at += chunk.length
  }
  return out
}
