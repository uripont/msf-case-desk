import { describe, expect, test } from 'vitest'

import { imageContextToken, imageReadQuery, parseImageContext } from './spec'

describe('the version an image is read through', () => {
  test('the query names the context and its number', () => {
    expect(imageReadQuery('r1', { kind: 'working_copy' })).toBe(
      'context=working_copy&report=r1',
    )
    expect(imageReadQuery('r1', { kind: 'draft', draft: 3 })).toBe(
      'context=draft&report=r1&draft=3',
    )
    expect(imageReadQuery('r1', { kind: 'revision', revision: 2 })).toBe(
      'context=revision&report=r1&revision=2',
    )
  })

  test('a token round-trips, and an empty or unknown one is the working copy', () => {
    for (const context of [
      { kind: 'working_copy' },
      { kind: 'draft', draft: 0 },
      { kind: 'draft', draft: 4 },
      { kind: 'revision', revision: 7 },
    ] as const) {
      expect(parseImageContext(imageContextToken(context))).toEqual(context)
    }
    expect(parseImageContext('')).toEqual({ kind: 'working_copy' })
    expect(parseImageContext('revision:0')).toEqual({ kind: 'working_copy' })
    expect(parseImageContext('draft:x')).toEqual({ kind: 'working_copy' })
  })
})
