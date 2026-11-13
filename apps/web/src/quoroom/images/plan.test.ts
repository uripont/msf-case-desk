import { Option } from 'effect'
import { describe, expect, test } from 'vitest'

import {
  IMAGE_CHUNK_BYTES,
  IMAGE_MAX_BYTES,
  IMAGE_MAX_CHUNKS,
  IMAGE_MAX_SIDE,
} from '@case-desk/domain'

import {
  JPEG_QUALITIES,
  decideAfterEncoding,
  fitWithin,
  fitsReport,
  formatBytes,
  formatFor,
  hasTransparency,
  isRetryable,
  percentDone,
  planChunks,
  refusalText,
  remainingBytes,
  routeErrorText,
  usageText,
} from './plan'

describe('fitWithin', () => {
  test('shrinks the longest side to the limit and keeps the proportions', () => {
    expect(fitWithin({ width: 4000, height: 3000 })).toEqual({
      width: 1600,
      height: 1200,
    })
    expect(fitWithin({ width: 3000, height: 4000 })).toEqual({
      width: 1200,
      height: 1600,
    })
    expect(fitWithin({ width: 1601, height: 1601 })).toEqual({
      width: 1600,
      height: 1600,
    })
  })

  test('never enlarges and never goes below one pixel', () => {
    expect(fitWithin({ width: 800, height: 600 })).toEqual({
      width: 800,
      height: 600,
    })
    expect(fitWithin({ width: 1600, height: 1600 })).toEqual({
      width: 1600,
      height: 1600,
    })
    expect(fitWithin({ width: 100_000, height: 10 })).toEqual({
      width: 1600,
      height: 1,
    })
  })

  test('is within the route limit whatever the input', () => {
    ;[
      [1, 1],
      [9999, 7],
      [7, 9999],
      [1599, 1601],
      [65_535, 65_535],
    ].forEach(([width = 1, height = 1]) => {
      const fitted = fitWithin({ width, height })
      expect(Math.max(fitted.width, fitted.height)).toBeLessThanOrEqual(
        IMAGE_MAX_SIDE,
      )
      expect(Math.min(fitted.width, fitted.height)).toBeGreaterThanOrEqual(1)
    })
  })
})

describe('hasTransparency', () => {
  test('an opaque picture has none', () => {
    expect(
      hasTransparency(new Uint8ClampedArray([1, 2, 3, 255, 4, 5, 6, 255])),
    ).toBe(false)
    expect(hasTransparency(new Uint8ClampedArray([]))).toBe(false)
  })

  test('one translucent pixel is enough, wherever it is', () => {
    expect(
      hasTransparency(new Uint8ClampedArray([1, 2, 3, 255, 4, 5, 6, 254])),
    ).toBe(true)
    expect(hasTransparency(new Uint8ClampedArray([1, 2, 3, 0]))).toBe(true)
  })

  test('only the alpha byte counts', () => {
    expect(
      hasTransparency(new Uint8ClampedArray([0, 0, 0, 255, 0, 0, 0, 255])),
    ).toBe(false)
  })
})

describe('the output format and the quality retry', () => {
  test('an opaque picture is a JPEG with a lower quality to fall back to', () => {
    const format = formatFor(false)
    expect(format.mime).toBe('image/jpeg')
    expect(format.qualities).toEqual(JPEG_QUALITIES)
    expect(JPEG_QUALITIES.length).toBe(2)
    expect(JPEG_QUALITIES[1]).toBeLessThan(JPEG_QUALITIES[0] ?? 0)
  })

  test('a transparent picture stays a PNG with no second try', () => {
    const format = formatFor(true)
    expect(format.mime).toBe('image/png')
    expect(format.qualities.length).toBe(1)
  })

  test('within the limit is accepted, at exactly the limit too', () => {
    expect(decideAfterEncoding(formatFor(false), 0, 10)).toEqual({
      kind: 'accept',
    })
    expect(decideAfterEncoding(formatFor(false), 0, IMAGE_MAX_BYTES)).toEqual({
      kind: 'accept',
    })
  })

  test('a JPEG over the limit gets one lower quality, then is refused', () => {
    const jpeg = formatFor(false)
    expect(decideAfterEncoding(jpeg, 0, IMAGE_MAX_BYTES + 1)).toEqual({
      kind: 'retry',
      quality: JPEG_QUALITIES[1],
    })
    expect(decideAfterEncoding(jpeg, 1, IMAGE_MAX_BYTES + 1)).toEqual({
      kind: 'refuse',
    })
    expect(decideAfterEncoding(jpeg, 1, 1000)).toEqual({ kind: 'accept' })
  })

  test('a PNG over the limit is tried again at 1200 and 900 pixels, then refused', () => {
    const png = formatFor(true)
    expect(png.sides).toEqual([IMAGE_MAX_SIDE, 1200, 900])
    const over = IMAGE_MAX_BYTES + 1
    expect(decideAfterEncoding(png, 0, over, 0)).toEqual({
      kind: 'shrink',
      side: 1200,
    })
    expect(decideAfterEncoding(png, 0, over, 1)).toEqual({
      kind: 'shrink',
      side: 900,
    })
    expect(decideAfterEncoding(png, 0, over, 2)).toEqual({ kind: 'refuse' })
    expect(decideAfterEncoding(png, 0, IMAGE_MAX_BYTES, 1)).toEqual({
      kind: 'accept',
    })
  })

  test('a JPEG is never drawn smaller, only given a lower quality', () => {
    expect(formatFor(false).sides).toEqual([IMAGE_MAX_SIDE])
  })
})

describe('the refusals', () => {
  test('a file over the caps says what the limit is', () => {
    expect(
      refusalText({ kind: 'file_too_large', bytes: 45_000_000 }),
    ).toContain('30.0 MB')
    expect(
      refusalText({ kind: 'too_many_pixels', pixels: 250_000_000 }),
    ).toContain('100 million')
  })

  test('the route code for hidden information has words', () => {
    expect(routeErrorText('has_metadata', 415)).toContain('hidden information')
  })
})

describe('planChunks', () => {
  test('a small image is one chunk', () => {
    expect(planChunks(10)).toEqual([{ index: 0, start: 0, end: 10 }])
    expect(planChunks(IMAGE_CHUNK_BYTES)).toEqual([
      { index: 0, start: 0, end: IMAGE_CHUNK_BYTES },
    ])
  })

  test('a larger one is cut at the chunk size, in order, with a short last chunk', () => {
    const plan = planChunks(IMAGE_MAX_BYTES)
    expect(plan).toEqual([
      { index: 0, start: 0, end: IMAGE_CHUNK_BYTES },
      { index: 1, start: IMAGE_CHUNK_BYTES, end: IMAGE_MAX_BYTES },
    ])
  })

  test('the chunks cover the image exactly, and never exceed what the route allows', () => {
    ;[1, 699_999, 700_000, 700_001, 999_999, IMAGE_MAX_BYTES].forEach(size => {
      const plan = planChunks(size)
      expect(plan.length).toBeLessThanOrEqual(IMAGE_MAX_CHUNKS)
      expect(plan[0]?.start).toBe(0)
      expect(plan.at(-1)?.end).toBe(size)
      plan.forEach((range, at) => {
        expect(range.index).toBe(at)
        expect(range.end - range.start).toBeLessThanOrEqual(IMAGE_CHUNK_BYTES)
        expect(range.end).toBeGreaterThan(range.start)
        if (at > 0) {
          expect(range.start).toBe(plan[at - 1]?.end)
        }
      })
    })
  })

  test('nothing to send makes no chunks', () => {
    expect(planChunks(0)).toEqual([])
  })
})

describe('progress and words', () => {
  test('percentDone rounds down and stays within 0 and 100', () => {
    expect(percentDone(0, 100)).toBe(0)
    expect(percentDone(1, 3)).toBe(33)
    expect(percentDone(100, 100)).toBe(100)
    expect(percentDone(500, 100)).toBe(100)
    expect(percentDone(5, 0)).toBe(0)
  })

  test('sizes are shown in KB below a megabyte and in MB above', () => {
    expect(formatBytes(0)).toBe('0 KB')
    expect(formatBytes(400_000)).toBe('400 KB')
    expect(formatBytes(1_000_000)).toBe('1.0 MB')
    expect(formatBytes(20_000_000)).toBe('20.0 MB')
    expect(formatBytes(1_250_000)).toBe('1.3 MB')
  })

  test('the usage line shows used, limit and what is left', () => {
    const usage = { usedBytes: 4_500_000, limitBytes: 20_000_000 }
    expect(remainingBytes(usage)).toBe(15_500_000)
    expect(usageText(usage)).toContain('4.5 MB of 20.0 MB used, 15.5 MB left')
    expect(
      remainingBytes({ usedBytes: 30_000_000, limitBytes: 20_000_000 }),
    ).toBe(0)
  })

  test('an image that does not fit what is left is refused, an unknown space is not a refusal', () => {
    expect(fitsReport(500_000, Option.some(499_999))).toBe(false)
    expect(fitsReport(500_000, Option.some(500_000))).toBe(true)
    expect(fitsReport(500_000, Option.none())).toBe(true)
  })

  test('every refusal says what to do or what the limit is', () => {
    expect(
      refusalText({ kind: 'too_large_after_encoding', bytes: 1_800_000 }),
    ).toMatch(/1\.8 MB.*limit is 1\.0 MB/)
    expect(
      refusalText({ kind: 'report_full', remaining: 100_000, bytes: 600_000 }),
    ).toMatch(/600 KB.*100 KB of image space left/)
    expect(refusalText({ kind: 'not_an_image' })).toMatch(/not a picture/)
    expect(refusalText({ kind: 'unreadable' })).toMatch(/could not be read/)
  })

  test('route errors are explained without echoing the server text', () => {
    expect(routeErrorText('database_full', 507)).toMatch(/storage .* full/)
    expect(routeErrorText('report_limit', 409)).toMatch(/20\.0 MB/)
    expect(routeErrorText('read_only', 409)).toMatch(/archived/)
    expect(routeErrorText('unknown', 503)).toMatch(/Try again/)
    expect(routeErrorText('whatever', 400)).toMatch(/did not accept/)
  })

  test('only network and server trouble is retried, a full database is not', () => {
    ;[0, 408, 429, 500, 502, 503].forEach(status =>
      expect(isRetryable(status)).toBe(true),
    )
    ;[400, 404, 409, 413, 415, 507].forEach(status =>
      expect(isRetryable(status)).toBe(false),
    )
  })
})
