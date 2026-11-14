import { Result } from 'effect'
import fc from 'fast-check'
import { describe, expect, test } from 'vitest'

import { blankTemplate, slug, validateTemplate } from './index'

const SHORT_NAME = /^[a-z][a-z0-9-]{0,23}$/

describe('the short name made from a template name', () => {
  test('always fits the short name pattern, for any name', () => {
    fc.assert(
      fc.property(fc.string({ unit: 'binary', maxLength: 300 }), name => {
        expect(slug(name)).toMatch(SHORT_NAME)
      }),
      { numRuns: 500 },
    )
  })

  test.each([
    ['', 'template'],
    ['   ', 'template'],
    ['日本語の報告', 'template'],
    ['2024 review of a rather long name', 't-2024-review-of-a-rathe'],
    ['1234567890123456789012345678901234567890', 't-1234567890123456789012'],
    ['Panel review note', 'panel-review-note'],
    ['A very long template name that goes on and on', 'a-very-long-template-nam'],
  ])('%j becomes %j', (name, expected) => {
    expect(slug(name)).toBe(expected)
  })

  test('a blank template made from awkward names is valid as it is', () => {
    fc.assert(
      fc.property(fc.stringMatching(/^[0-9a-zA-Zé一-丐 -]{1,60}$/), raw => {
        const name = raw.trim()
        fc.pre(name.length > 0)
        const result = validateTemplate(blankTemplate('t1', name))
        expect(Result.isSuccess(result)).toBe(true)
      }),
      { numRuns: 200 },
    )
  })
})
