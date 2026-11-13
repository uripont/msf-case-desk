import { describe, expect, test } from 'vitest'

import {
  COLUMN_MAX_WIDTH,
  COLUMN_MIN_WIDTH,
  COLUMN_STEP,
  nextColumnWidth,
  withColumnWidth,
} from './columns'

describe('nextColumnWidth', () => {
  test('widens and narrows the stored width by one step', () => {
    expect(nextColumnWidth(200, 999, 'widen')).toBe(200 + COLUMN_STEP)
    expect(nextColumnWidth(200, 999, 'narrow')).toBe(200 - COLUMN_STEP)
  })

  test('starts from the drawn width when the column has none stored', () => {
    expect(nextColumnWidth(undefined, 150, 'widen')).toBe(150 + COLUMN_STEP)
    expect(nextColumnWidth(null, 150.4, 'narrow')).toBe(150 - COLUMN_STEP)
    expect(nextColumnWidth(0, 150, 'widen')).toBe(150 + COLUMN_STEP)
  })

  test('stays between the minimum and the maximum', () => {
    expect(nextColumnWidth(COLUMN_MIN_WIDTH, 0, 'narrow')).toBe(COLUMN_MIN_WIDTH)
    expect(nextColumnWidth(COLUMN_MIN_WIDTH + 1, 0, 'narrow')).toBe(COLUMN_MIN_WIDTH)
    expect(nextColumnWidth(COLUMN_MAX_WIDTH, 0, 'widen')).toBe(COLUMN_MAX_WIDTH)
  })

  test('the result is always a whole number the schema accepts', () => {
    ;[undefined, 0, 80, 99.5, 1999, 2000].forEach(current => {
      ;(['widen', 'narrow'] as const).forEach(direction => {
        const width = nextColumnWidth(current, 123.7, direction)
        expect(Number.isInteger(width)).toBe(true)
        expect(width).toBeGreaterThanOrEqual(1)
        expect(width).toBeLessThanOrEqual(COLUMN_MAX_WIDTH)
      })
    })
  })

  test('repeated steps are reversible away from the limits', () => {
    const wider = nextColumnWidth(200, 0, 'widen')
    expect(nextColumnWidth(wider, 0, 'narrow')).toBe(200)
  })
})

describe('withColumnWidth', () => {
  test('a single column gets just the width', () => {
    expect(withColumnWidth(undefined, 1, 0, 240)).toEqual([240])
    expect(withColumnWidth([100], 1, 0, 240)).toEqual([240])
  })

  test('in a cell over two columns only one entry changes and none is below 1', () => {
    expect(withColumnWidth([100, 150], 2, 1, 240)).toEqual([100, 240])
    expect(withColumnWidth(undefined, 2, 1, 240)).toEqual([COLUMN_MIN_WIDTH, 240])
    expect(withColumnWidth([0, 150], 2, 1, 240)).toEqual([COLUMN_MIN_WIDTH, 240])
  })
})
