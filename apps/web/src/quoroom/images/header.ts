import { Option } from 'effect'

import { MAX_INPUT_BYTES, MAX_INPUT_PIXELS, type Size, fitWithin } from './plan'

// NOTE: Reading the size of a picture from its first bytes, before anything is
// decoded. A phone or a scanner can make a file of 100 MB or
// of hundreds of megapixels that would use gigabytes of memory when decoded; a
// small file can too (a compressed PNG of a blank sheet). So `encode.ts` reads
// the first `HEADER_BYTES` of the file, asks `readHeader` for the pixel size
// (PNG, JPEG, WebP and GIF headers) and refuses a file over the caps below
// before it is decoded. When it is decoded it is decoded straight to the target
// size (`decodeSize`), never first at full size. Pure: bytes in, numbers out.

// NOTE: How much of the start of a file is read. A JPEG may carry a large
// block (EXIF with a thumbnail, a colour profile) before its size, so this is
// generous; a header not found within it is treated as unreadable.
export const HEADER_BYTES = 1_000_000

export type Header = Readonly<{
  format: 'png' | 'jpeg' | 'webp' | 'gif'
  // NOTE: As stored in the file, before any rotation.
  width: number
  height: number
  // NOTE: EXIF orientation, 1 to 8 (5 to 8 turn the picture a quarter turn).
  orientation: number
}>

const u16be = (b: Uint8Array, at: number): number =>
  ((b[at] ?? 0) << 8) | (b[at + 1] ?? 0)
const u32be = (b: Uint8Array, at: number): number =>
  u16be(b, at) * 65536 + u16be(b, at + 2)
const u16le = (b: Uint8Array, at: number): number =>
  (b[at] ?? 0) | ((b[at + 1] ?? 0) << 8)
const u24le = (b: Uint8Array, at: number): number =>
  u16le(b, at) | ((b[at + 2] ?? 0) << 16)
const u32le = (b: Uint8Array, at: number): number =>
  u16le(b, at) + u16le(b, at + 2) * 65536

const ascii = (b: Uint8Array, at: number, text: string): boolean =>
  [...text].every((character, i) => b[at + i] === character.charCodeAt(0))

const header = (
  format: Header['format'],
  width: number,
  height: number,
  orientation = 1,
): Option.Option<Header> =>
  width > 0 && height > 0
    ? Option.some({ format, width, height, orientation })
    : Option.none()

const png = (b: Uint8Array): Option.Option<Header> =>
  [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every(
    (x, i) => b[i] === x,
  ) && ascii(b, 12, 'IHDR')
    ? header('png', u32be(b, 16), u32be(b, 20))
    : Option.none()

const gif = (b: Uint8Array): Option.Option<Header> =>
  ascii(b, 0, 'GIF8') ? header('gif', u16le(b, 6), u16le(b, 8)) : Option.none()

const webp = (b: Uint8Array): Option.Option<Header> => {
  if (!ascii(b, 0, 'RIFF') || !ascii(b, 8, 'WEBP')) {
    return Option.none()
  }
  if (ascii(b, 12, 'VP8X')) {
    return header('webp', u24le(b, 24) + 1, u24le(b, 27) + 1)
  }
  if (ascii(b, 12, 'VP8L')) {
    const bits = u32le(b, 21)
    return header('webp', (bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1)
  }
  if (ascii(b, 12, 'VP8 ')) {
    return header('webp', u16le(b, 26) & 0x3fff, u16le(b, 28) & 0x3fff)
  }
  return Option.none()
}

// NOTE: The orientation tag of an EXIF block (`at` is where "Exif\0\0" starts).
const exifOrientation = (b: Uint8Array, at: number, end: number): number => {
  const tiff = at + 6
  const little = b[tiff] === 0x49
  const u16 = (x: number) => (little ? u16le(b, x) : u16be(b, x))
  const u32 = (x: number) => (little ? u32le(b, x) : u32be(b, x))
  if (tiff + 8 > end || u16(tiff + 2) !== 42) {
    return 1
  }
  const directory = tiff + u32(tiff + 4)
  const count = u16(directory)
  for (let entry = 0; entry < count; entry += 1) {
    const field = directory + 2 + entry * 12
    if (field + 12 > end) {
      return 1
    }
    if (u16(field) === 0x0112) {
      const value = u16(field + 8)
      return value >= 1 && value <= 8 ? value : 1
    }
  }
  return 1
}

const jpeg = (b: Uint8Array): Option.Option<Header> => {
  if (b[0] !== 0xff || b[1] !== 0xd8) {
    return Option.none()
  }
  let at = 2
  let orientation = 1
  // NOTE: a walk over the segments (marker, length); the size is in the first
  // start-of-frame segment. Bounded by the bytes given.
  while (at + 4 <= b.length) {
    if (b[at] !== 0xff) {
      return Option.none()
    }
    const marker = b[at + 1] ?? 0
    if (marker === 0xff) {
      at += 1
      continue
    }
    if (
      marker === 0xd8 ||
      marker === 0x01 ||
      (marker >= 0xd0 && marker <= 0xd7)
    ) {
      at += 2
      continue
    }
    const length = u16be(b, at + 2)
    if (marker === 0xe1 && ascii(b, at + 4, 'Exif')) {
      orientation = exifOrientation(
        b,
        at + 4,
        Math.min(b.length, at + 2 + length),
      )
    }
    const isFrame =
      marker >= 0xc0 &&
      marker <= 0xcf &&
      marker !== 0xc4 &&
      marker !== 0xc8 &&
      marker !== 0xcc
    if (isFrame) {
      return at + 9 <= b.length
        ? header('jpeg', u16be(b, at + 7), u16be(b, at + 5), orientation)
        : Option.none()
    }
    if (marker === 0xda || length < 2) {
      return Option.none()
    }
    at += 2 + length
  }
  return Option.none()
}

export const readHeader = (bytes: Uint8Array): Option.Option<Header> =>
  [png, jpeg, webp, gif].reduce<Option.Option<Header>>(
    (found, parse) => (Option.isSome(found) ? found : parse(bytes)),
    Option.none(),
  )

// NOTE: The size the picture has once turned upright, which is what the
// decoder resizes and what the author sees.
export const uprightSize = (found: Header): Size =>
  found.orientation >= 5
    ? { width: found.height, height: found.width }
    : { width: found.width, height: found.height }

export type InputCheck =
  | Readonly<{ kind: 'ok' }>
  | Readonly<{ kind: 'file_too_large'; bytes: number }>
  | Readonly<{ kind: 'too_many_pixels'; pixels: number }>

// NOTE: The caps, applied to the file size and to the size in its header.
export const checkInput = (fileBytes: number, found: Size): InputCheck =>
  fileBytes > MAX_INPUT_BYTES
    ? { kind: 'file_too_large', bytes: fileBytes }
    : found.width * found.height > MAX_INPUT_PIXELS
      ? { kind: 'too_many_pixels', pixels: found.width * found.height }
      : { kind: 'ok' }

// NOTE: The size to ask the decoder for: the target size (within the longest
// side) when the picture is larger than that, None when it is small enough to
// decode as it is.
export const decodeSize = (upright: Size): Option.Option<Size> => {
  const target = fitWithin(upright)
  return target.width < upright.width || target.height < upright.height
    ? Option.some(target)
    : Option.none()
}
