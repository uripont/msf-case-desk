import { Schema } from 'effect'
import fc from 'fast-check'
import { describe, expect, test } from 'vitest'

import { Col, Tolerant } from './compat'

const OldRisk = Schema.Literals(['Low', 'High'])
const NewRisk = Schema.Literals(['Low', 'High', 'Critical'])

const OldRow = Schema.Struct({
  id: Schema.String,
  risk: Tolerant(OldRisk),
})

const NewRow = Schema.Struct({
  id: Schema.String,
  risk: Tolerant(NewRisk),
  note: Col(Schema.String, ''),
  tags: Col(Schema.Array(Schema.String), []),
})

const decodeOld = Schema.decodeUnknownSync(OldRow)
const decodeNew = Schema.decodeUnknownSync(NewRow)

describe('Tolerant', () => {
  test('an old reader decodes a value added later as Unknown', () => {
    expect(decodeOld({ id: 'a', risk: 'Critical' }).risk).toBe('Unknown')
  })

  test('known values decode unchanged', () => {
    expect(decodeOld({ id: 'a', risk: 'High' }).risk).toBe('High')
  })

  test('any string decodes without failing', () => {
    fc.assert(
      fc.property(fc.string(), risk => {
        const decoded = decodeOld({ id: 'a', risk }).risk
        expect(['Low', 'High', 'Unknown']).toContain(decoded)
      }),
    )
  })
})

describe('Col', () => {
  test('a new reader gives a missing column its default', () => {
    expect(decodeNew({ id: 'a', risk: 'Low' })).toEqual({
      id: 'a',
      risk: 'Low',
      note: '',
      tags: [],
    })
  })

  test('a new reader gives a NULL column its default', () => {
    expect(decodeNew({ id: 'a', risk: 'Low', note: null, tags: null })).toEqual(
      { id: 'a', risk: 'Low', note: '', tags: [] },
    )
  })

  test('an old reader ignores columns it does not know', () => {
    expect(
      decodeOld({ id: 'a', risk: 'Low', note: 'added later', tags: ['x'] }),
    ).toEqual({ id: 'a', risk: 'Low' })
  })

  test('present values are kept', () => {
    expect(
      decodeNew({ id: 'a', risk: 'Critical', note: 'n', tags: ['x'] }),
    ).toEqual({ id: 'a', risk: 'Critical', note: 'n', tags: ['x'] })
  })
})
