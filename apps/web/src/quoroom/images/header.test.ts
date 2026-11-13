import { Option } from 'effect'
import { describe, expect, test } from 'vitest'

import { checkInput, decodeSize, readHeader, uprightSize } from './header'
import { MAX_INPUT_BYTES, MAX_INPUT_PIXELS } from './plan'

const be32 = (n: number) => [
  (n >>> 24) & 255,
  (n >>> 16) & 255,
  (n >>> 8) & 255,
  n & 255,
]
const be16 = (n: number) => [(n >>> 8) & 255, n & 255]
const ascii = (text: string) => [...text].map(c => c.charCodeAt(0))

const png = (w: number, h: number) =>
  new Uint8Array([
    0x89,
    0x50,
    0x4e,
    0x47,
    0x0d,
    0x0a,
    0x1a,
    0x0a,
    ...be32(13),
    ...ascii('IHDR'),
    ...be32(w),
    ...be32(h),
    8,
    6,
    0,
    0,
    0,
  ])

const exif = (orientation: number) => [
  ...ascii('Exif'),
  0,
  0,
  0x4d,
  0x4d,
  0,
  42,
  0,
  0,
  0,
  8,
  ...be16(1),
  ...be16(0x0112),
  ...be16(3),
  ...be32(1),
  ...be16(orientation),
  0,
  0,
  0,
  0,
  0,
  0,
]

const jpeg = (w: number, h: number, orientation?: number) => {
  const app1 =
    orientation === undefined
      ? []
      : [
          0xff,
          0xe1,
          ...be16(exif(orientation).length + 2),
          ...exif(orientation),
        ]
  const app0 = [
    0xff,
    0xe0,
    ...be16(16),
    ...ascii('JFIF'),
    0,
    ...new Array<number>(9).fill(0),
  ]
  return new Uint8Array([
    0xff,
    0xd8,
    ...app0,
    ...app1,
    0xff,
    0xc0,
    ...be16(17),
    8,
    ...be16(h),
    ...be16(w),
    3,
    1,
    0x22,
    0,
    2,
    0x11,
    1,
    3,
    0x11,
    1,
  ])
}

const gif = (w: number, h: number) =>
  new Uint8Array([
    ...ascii('GIF89a'),
    w & 255,
    w >> 8,
    h & 255,
    h >> 8,
    0,
    0,
    0,
  ])

const webpX = (w: number, h: number) => {
  const le24 = (n: number) => [n & 255, (n >> 8) & 255, (n >> 16) & 255]
  return new Uint8Array([
    ...ascii('RIFF'),
    0,
    0,
    0,
    0,
    ...ascii('WEBP'),
    ...ascii('VP8X'),
    10,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    ...le24(w - 1),
    ...le24(h - 1),
  ])
}

const size = (bytes: Uint8Array) => {
  const found = readHeader(bytes)
  return Option.isSome(found)
    ? [found.value.width, found.value.height]
    : undefined
}

describe('readHeader', () => {
  test('reads the size of a PNG, JPEG, GIF and WebP without decoding', () => {
    expect(size(png(4000, 3000))).toEqual([4000, 3000])
    expect(size(jpeg(6000, 4000))).toEqual([6000, 4000])
    expect(size(gif(320, 200))).toEqual([320, 200])
    expect(size(webpX(5000, 100))).toEqual([5000, 100])
  })

  test('reads the EXIF orientation of a JPEG and turns the size upright', () => {
    const found = readHeader(jpeg(4000, 3000, 6))
    expect(Option.isSome(found) && found.value.orientation).toBe(6)
    expect(Option.isSome(found) && uprightSize(found.value)).toEqual({
      width: 3000,
      height: 4000,
    })
  })

  test('something that is not a known picture, or is cut short, has no size', () => {
    expect(size(new Uint8Array([1, 2, 3, 4]))).toBeUndefined()
    expect(size(jpeg(10, 10).subarray(0, 12))).toBeUndefined()
    expect(size(png(0, 5))).toBeUndefined()
  })
})

describe('checkInput and decodeSize', () => {
  test('a file over the byte cap or the pixel cap is refused before decoding', () => {
    expect(checkInput(MAX_INPUT_BYTES + 1, { width: 10, height: 10 })).toEqual({
      kind: 'file_too_large',
      bytes: MAX_INPUT_BYTES + 1,
    })
    expect(checkInput(1000, { width: 20_000, height: 20_000 })).toMatchObject({
      kind: 'too_many_pixels',
    })
    expect(
      checkInput(MAX_INPUT_BYTES, {
        width: 10_000,
        height: MAX_INPUT_PIXELS / 10_000,
      }),
    ).toEqual({ kind: 'ok' })
  })

  test('a large picture is decoded straight to the target size, a small one as it is', () => {
    expect(decodeSize({ width: 4000, height: 3000 })).toEqual(
      Option.some({ width: 1600, height: 1200 }),
    )
    expect(decodeSize({ width: 800, height: 600 })).toEqual(Option.none())
  })
})
