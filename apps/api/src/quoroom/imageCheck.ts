// NOTE: What an uploaded image may carry (stage 4 review, D3). The browser
// always draws the picture on a canvas and saves that again, which leaves no
// metadata; the server does not trust that, so it refuses a file that carries
// any, instead of stripping (stripping means rewriting the file in the
// Worker). Only JPEG and PNG are accepted at all.
//
// WHEN: the check runs when the image is complete, over all its chunks joined
// (`images.ts` reads them back from the store), not per chunk. A chunk may end
// in the middle of a marker or a chunk type, so a per-chunk check would miss
// "tE|Xt"; the whole image is at most 1 MB, so joining is cheap. An image
// that fails is deleted again (nothing references a new upload).
//
// Refused: JPEG APP1 (EXIF, XMP) and APP13 (IPTC) segments and comments; PNG
// tEXt, zTXt, iTXt, eXIf and tIME chunks. A file whose structure cannot be
// walked to its end is refused as not a JPEG or PNG.

export type ImageCheck = 'clean' | 'has_metadata' | 'malformed'

const u32 = (b: Uint8Array, at: number): number =>
  ((b[at] ?? 0) * 16_777_216) +
  (((b[at + 1] ?? 0) << 16) | ((b[at + 2] ?? 0) << 8) | (b[at + 3] ?? 0))

const type4 = (b: Uint8Array, at: number): string =>
  String.fromCharCode(b[at] ?? 0, b[at + 1] ?? 0, b[at + 2] ?? 0, b[at + 3] ?? 0)

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
const PNG_METADATA: ReadonlySet<string> = new Set([
  'tEXt',
  'zTXt',
  'iTXt',
  'eXIf',
  'tIME',
])

const checkPng = (b: Uint8Array): ImageCheck => {
  if (!PNG_SIGNATURE.every((byte, at) => b[at] === byte)) return 'malformed'
  let at = 8
  let sawEnd = false
  while (at + 12 <= b.length) {
    const length = u32(b, at)
    const type = type4(b, at + 4)
    if (PNG_METADATA.has(type)) return 'has_metadata'
    const next = at + 12 + length
    if (next > b.length) return 'malformed'
    if (type === 'IEND') {
      sawEnd = true
      at = next
      break
    }
    at = next
  }
  return sawEnd && at === b.length ? 'clean' : 'malformed'
}

const checkJpeg = (b: Uint8Array): ImageCheck => {
  if (b[0] !== 0xff || b[1] !== 0xd8 || b[2] !== 0xff) return 'malformed'
  let at = 2
  while (at + 4 <= b.length) {
    if (b[at] !== 0xff) return 'malformed'
    const marker = b[at + 1] ?? 0
    if (marker === 0xff) {
      at += 1
      continue
    }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      at += 2
      continue
    }
    if (marker === 0xe1 || marker === 0xed || marker === 0xfe) {
      return 'has_metadata'
    }
    // NOTE: the entropy-coded data after the scan header holds no segments
    // that matter here; stop at the start of scan.
    if (marker === 0xda) return 'clean'
    const length = ((b[at + 2] ?? 0) << 8) | (b[at + 3] ?? 0)
    if (length < 2) return 'malformed'
    at += 2 + length
  }
  return 'malformed'
}

export const checkImageBytes = (
  mime: 'image/jpeg' | 'image/png',
  bytes: Uint8Array,
): ImageCheck => (mime === 'image/jpeg' ? checkJpeg(bytes) : checkPng(bytes))
