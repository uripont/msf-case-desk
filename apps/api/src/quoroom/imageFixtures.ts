// NOTE: tiny valid image files for the tests, built by hand. Synthetic.

const be32 = (n: number): Array<number> => [
  (n >>> 24) & 255,
  (n >>> 16) & 255,
  (n >>> 8) & 255,
  n & 255,
]
const ascii = (text: string): Array<number> =>
  [...text].map(c => c.charCodeAt(0))

// NOTE: the CRC is not checked by the route, so it is left at zero.
export const pngChunk = (type: string, data: ReadonlyArray<number>): Array<number> => [
  ...be32(data.length),
  ...ascii(type),
  ...data,
  0, 0, 0, 0,
]

export const pngSignature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]

export const pngIhdr = pngChunk('IHDR', [...be32(1), ...be32(1), 8, 2, 0, 0, 0])

// NOTE: a PNG with the given chunks between the header and the end; `idat`
// bytes of filler make it as long as a test needs.
export const makePng = (
  extra: ReadonlyArray<ReadonlyArray<number>> = [],
  idat = 12,
): Uint8Array =>
  new Uint8Array([
    ...pngSignature,
    ...pngIhdr,
    ...pngChunk('IDAT', Array.from({ length: idat }, () => 5)),
    ...extra.flat(),
    ...pngChunk('IEND', []),
  ])

export const makeJpeg = (segments: ReadonlyArray<ReadonlyArray<number>> = []): Uint8Array =>
  new Uint8Array([
    0xff, 0xd8,
    0xff, 0xe0, 0, 16, ...ascii('JFIF'), 0, 1, 1, 0, 0, 1, 0, 1, 0, 0,
    ...segments.flat(),
    0xff, 0xdb, 0, 4, 0, 1,
    0xff, 0xda, 0, 4, 0, 0,
    9, 9, 9,
    0xff, 0xd9,
  ])

export const exifSegment = [0xff, 0xe1, 0, 8, ...ascii('Exif'), 0, 0].slice(0, 12)
