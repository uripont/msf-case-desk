import { Schema } from 'effect'
import { describe, expect, test } from 'vitest'

import { Comparison } from '@case-desk/domain'

import { AUTOMATIC_LIMIT, capAutomatic } from './support'

describe('the list of automatic changes in a comparison', () => {
  test('a list within the cap is whole and leaves nothing out', () => {
    expect(capAutomatic([1, 2, 3], 5)).toEqual({ automatic: [1, 2, 3], omitted: 0 })
    expect(capAutomatic([1, 2, 3], 3)).toEqual({ automatic: [1, 2, 3], omitted: 0 })
  })

  test('a longer list is cut and says how many were left out', () => {
    expect(capAutomatic([1, 2, 3, 4, 5], 2)).toEqual({ automatic: [1, 2], omitted: 3 })
    const many = Array.from({ length: AUTOMATIC_LIMIT + 7 }, (_, at) => at)
    const capped = capAutomatic(many)
    expect(capped.automatic).toHaveLength(AUTOMATIC_LIMIT)
    expect(capped.omitted).toBe(7)
  })

  test('the comparison schema carries the count, and still accepts one without it', () => {
    const base = { baseDraft: 1, theirsDraft: 2, conflicts: [], automatic: [], problems: [] }
    const decode = Schema.decodeUnknownSync(Comparison)
    expect(decode(base).automaticOmitted).toBeUndefined()
    expect(decode({ ...base, automaticOmitted: 12 }).automaticOmitted).toBe(12)
  })
})
