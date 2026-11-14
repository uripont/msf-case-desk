import { Effect } from 'effect'
import { describe, expect, test } from 'vitest'

import type { DownloadSet } from '@case-desk/domain'
import { checkZipSize, zipParts } from '@case-desk/pdf'

import { makeFailureOf, zipDateOf } from './downloads'
import { type ImageCache, imagesOf } from './pdf/source'

// NOTE: Stage 8+9 review, finding 10: "Download all" gives the same zip for
// the same report, refuses one that is too large with a clear message, and
// reads an image once across the versions.

const at = (...days: ReadonlyArray<number>): typeof DownloadSet.Type => ({
  reportName: 'Intake report',
  caseReference: 'SYN-1',
  approvalRecord: false,
  versions: days.map(day => ({
    kind: 'draft',
    number: day,
    label: `Draft ${day}`,
    view: 'original',
    closing: false,
    at: Date.UTC(2026, 2, day, 14, 30),
  })),
})

describe('the date in a zip', () => {
  test('is the newest version at midnight UTC, whatever the clock', () => {
    expect(zipDateOf(at(2, 5, 3)).toISOString()).toBe(
      '2026-03-05T00:00:00.000Z',
    )
  })

  test('gives the same bytes for the same files', () => {
    const entries = [{ name: 'a.pdf', data: new Uint8Array([1, 2, 3]) }]
    const bytes = (parts: ReadonlyArray<Uint8Array>) =>
      parts.flatMap(part => [...part])
    const once = bytes(zipParts(entries, zipDateOf(at(4))))
    const twice = bytes(zipParts(entries, zipDateOf(at(4))))
    expect(once).toEqual(twice)
  })
})

describe('a zip that is too large', () => {
  test('is refused with words, not as unavailable', () => {
    const failure = Effect.runSync(
      Effect.match(Effect.try(() => checkZipSize([1_600_000_000])), {
        onFailure: makeFailureOf,
        onSuccess: () => undefined,
      }),
    )
    expect(failure?._tag).toBe('Refused')
    expect(JSON.stringify(failure)).toContain('too large')
  })
})

describe('images across versions', () => {
  test('a cached image is not read again', async () => {
    const cache: ImageCache = new Map([['img-1', 'data:image/png;base64,AA==']])
    const found = await Effect.runPromise(
      imagesOf(
        'report-1',
        {
          description: { imageIds: ['img-1'] },
          context: { kind: 'revision', revision: 1 },
          logoImageId: undefined,
        },
        cache,
      ),
    )
    expect(found.get('img-1')).toBe('data:image/png;base64,AA==')
  })
})
