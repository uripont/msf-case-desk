import { Option } from 'effect'
import { describe, expect, test } from 'vitest'

import {
  countdownText,
  dateTextIn,
  deadlineText,
  isKnownZone,
  zoneChoices,
  zonedTimeToEpoch,
} from './zoned'
import { toDateTimeInput } from '../entryForm'
import { formatInstant } from '../format'
import { momentText, timeText } from './draftText'
import { formatMoment } from './ui'

describe('zoned deadlines', () => {
  test('a wall clock time in a zone is the right instant, in winter and in summer', () => {
    expect(zonedTimeToEpoch('2026-11-24', '18:00', 'Europe/Madrid')).toEqual(
      Option.some(Date.UTC(2026, 10, 24, 17, 0)),
    )
    expect(zonedTimeToEpoch('2026-07-01', '18:00', 'Europe/Madrid')).toEqual(
      Option.some(Date.UTC(2026, 6, 1, 16, 0)),
    )
    expect(zonedTimeToEpoch('2026-11-24', '18:00', 'Asia/Tokyo')).toEqual(
      Option.some(Date.UTC(2026, 10, 24, 9, 0)),
    )
    expect(zonedTimeToEpoch('2026-11-24', '18:00', 'UTC')).toEqual(
      Option.some(Date.UTC(2026, 10, 24, 18, 0)),
    )
  })

  test('text that is not a date, a time or a zone gives nothing', () => {
    expect(Option.isNone(zonedTimeToEpoch('24/11/2026', '18:00', 'UTC'))).toBe(
      true,
    )
    expect(Option.isNone(zonedTimeToEpoch('2026-02-30', '18:00', 'UTC'))).toBe(
      true,
    )
    expect(Option.isNone(zonedTimeToEpoch('2026-11-24', '25:00', 'UTC'))).toBe(
      true,
    )
    expect(
      Option.isNone(zonedTimeToEpoch('2026-11-24', '18:00', 'Not/AZone')),
    ).toBe(true)
    expect(isKnownZone('Europe/Madrid')).toBe(true)
    expect(isKnownZone('')).toBe(false)
  })

  test('a deadline reads on the wall clock of its own zone, with a countdown', () => {
    const at = Date.UTC(2026, 10, 24, 17, 0)
    expect(deadlineText(at, 'Europe/Madrid')).toBe('24 Nov, 18:00 Madrid time')
    expect(deadlineText(at, 'Asia/Tokyo')).toBe('25 Nov, 02:00 Tokyo time')
    expect(dateTextIn(at, 'Asia/Tokyo')).toBe('2026-11-25')
    expect(countdownText(at, at - (3 * 1440 + 4 * 60) * 60_000)).toBe(
      '3d 4h left',
    )
    expect(countdownText(at, at - 95 * 60_000)).toBe('1h 35m left')
    expect(countdownText(at, at - 20_000)).toBe('1m left')
    expect(countdownText(at, at + 1)).toBe('The deadline has passed')
  })

  test('the author’s own zone is always offered', () => {
    expect(zoneChoices('Pacific/Auckland')[0]).toBe('Pacific/Auckland')
    expect(zoneChoices('Europe/Madrid')).toContain('Europe/Madrid')
  })
})

describe('formatting never throws on a stored value', () => {
  test.each([8.7e15, -8.7e15, Number.MAX_SAFE_INTEGER, Number.NaN, Number.POSITIVE_INFINITY])(
    'a time of %s reads as text, in every formatter',
    value => {
      expect(typeof deadlineText(value, 'Europe/Madrid')).toBe('string')
      expect(typeof deadlineText(value, 'Not/AZone')).toBe('string')
      expect(typeof dateTextIn(value, 'UTC')).toBe('string')
      expect(typeof formatMoment(value)).toBe('string')
      expect(typeof formatInstant(value)).toBe('string')
      expect(typeof momentText(value)).toBe('string')
      expect(typeof timeText(value)).toBe('string')
      expect(typeof toDateTimeInput(value)).toBe('string')
    },
  )
})
