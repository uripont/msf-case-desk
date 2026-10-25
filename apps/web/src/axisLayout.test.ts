import { Option } from 'effect'
import { describe, expect, test } from 'vitest'

import {
  NOW_AT,
  TIMELINE_AHEAD_MIN_PX,
  TIMELINE_INSET_PX,
  TIMELINE_LATE_MIN_PX,
  TIMELINE_ROW_PX,
  axisPosition,
  heroLayoutForViewport,
  isAnimatedLayoutChange,
  lanesOf,
  markDomId,
  neighbourOf,
  spreadLabels,
  tabStopOf,
  timelineGeometryOf,
  timelineYOf,
} from './axisLayout'
import { formatSlaCompact, formatSlaSpoken, spokenDuration } from './format'

const HOUR_MS = 3_600_000

describe('axisPosition', () => {
  test('now sits at its fixed share and the scale widens near now', () => {
    expect(axisPosition(0, 96)).toBe(NOW_AT)
    expect(axisPosition(96, 96)).toBe(100)
    expect(axisPosition(-48, 96)).toBe(0)
    const firstSixHours = axisPosition(6, 96) - axisPosition(0, 96)
    const lastSixHours = axisPosition(96, 96) - axisPosition(90, 96)
    expect(firstSixHours).toBeGreaterThan(lastSixHours)
  })
})

describe('spreadLabels', () => {
  test('leaves labels that do not collide where they are', () => {
    expect(spreadLabels([30, 100, 200], 48, 0, 400)).toEqual([30, 100, 200])
  })

  test('pushes colliding labels apart around their shared centre', () => {
    expect(spreadLabels([100, 100], 48, 0, 400)).toEqual([76, 124])
  })

  test('keeps every label inside the bounds', () => {
    const placed = spreadLabels([0, 0, 0], 48, 24, 400)
    expect(placed).toEqual([24, 72, 120])
  })

  test('keeps at least one gap between neighbours after merging clusters', () => {
    const placed = spreadLabels([100, 110, 150, 160, 300], 48, 0, 600)
    placed.slice(1).forEach((position, index) => {
      expect(position - (placed[index] ?? 0)).toBeGreaterThanOrEqual(48)
    })
  })

  test('spaces labels evenly when they cannot all fit', () => {
    expect(spreadLabels([5, 5, 5], 48, 0, 40)).toEqual([0, 20, 40])
  })
})

describe('timeline geometry', () => {
  test('gives each side room for one row per case', () => {
    const quiet = timelineGeometryOf(0, 3)
    expect(quiet.lateSpan).toBe(TIMELINE_LATE_MIN_PX)
    expect(quiet.aheadSpan).toBe(TIMELINE_AHEAD_MIN_PX)
    expect(quiet.nowY).toBe(TIMELINE_INSET_PX + TIMELINE_LATE_MIN_PX)

    const crowded = timelineGeometryOf(4, 12)
    expect(crowded.lateSpan).toBe(4 * TIMELINE_ROW_PX)
    expect(crowded.aheadSpan).toBe(12 * TIMELINE_ROW_PX)
  })

  test('places overdue cases above now and the rest below it', () => {
    const geometry = timelineGeometryOf(1, 4)
    expect(timelineYOf(0, 96, geometry)).toBe(geometry.nowY)
    expect(timelineYOf(-3, 96, geometry)).toBeLessThan(geometry.nowY)
    expect(timelineYOf(-48, 96, geometry)).toBe(TIMELINE_INSET_PX)
    expect(timelineYOf(96, 96, geometry)).toBe(
      geometry.height - TIMELINE_INSET_PX,
    )
  })
})

describe('lanesOf', () => {
  test('keeps marks on the axis until they would overlap', () => {
    expect(lanesOf([0, 20, 40], 12, 3)).toEqual([0, 0, 0])
    expect(lanesOf([0, 4, 8, 30], 12, 3)).toEqual([0, 1, 2, 0])
  })

  test('reuses the lane that was freed longest ago when all are busy', () => {
    expect(lanesOf([0, 1, 2, 3], 12, 3)).toEqual([0, 1, 2, 0])
  })
})

describe('keyboard movement', () => {
  const ids = ['a', 'b', 'c']

  test('arrow keys move one case at a time and stop at the ends', () => {
    expect(neighbourOf(ids, 'a', 'ArrowRight')).toEqual(Option.some('b'))
    expect(neighbourOf(ids, 'b', 'ArrowDown')).toEqual(Option.some('c'))
    expect(neighbourOf(ids, 'c', 'ArrowDown')).toEqual(Option.none())
    expect(neighbourOf(ids, 'b', 'ArrowUp')).toEqual(Option.some('a'))
    expect(neighbourOf(ids, 'a', 'ArrowLeft')).toEqual(Option.none())
  })

  test('home and end jump to the first and last case', () => {
    expect(neighbourOf(ids, 'b', 'Home')).toEqual(Option.some('a'))
    expect(neighbourOf(ids, 'a', 'End')).toEqual(Option.some('c'))
    expect(neighbourOf(ids, 'a', 'Enter')).toEqual(Option.none())
  })

  test('the single tab stop follows focus, then selection, then the first case', () => {
    expect(tabStopOf(ids, Option.some('c'), Option.some('b'))).toEqual(
      Option.some('c'),
    )
    expect(tabStopOf(ids, Option.none(), Option.some('b'))).toEqual(
      Option.some('b'),
    )
    expect(tabStopOf(ids, Option.some('z'), Option.none())).toEqual(
      Option.some('a'),
    )
    expect(tabStopOf([], Option.none(), Option.none())).toEqual(Option.none())
  })
})

describe('spoken time left', () => {
  test('reads durations as words', () => {
    expect(spokenDuration(16 * HOUR_MS)).toBe('16 hours')
    expect(spokenDuration(28 * HOUR_MS)).toBe('1 day 4 hours')
    expect(spokenDuration(HOUR_MS + 60_000)).toBe('1 hour 1 minute')
    expect(spokenDuration(48 * HOUR_MS)).toBe('2 days')
  })

  test('says whether a case is due soon or overdue', () => {
    expect(
      formatSlaSpoken({ _tag: 'OnTrack', remainingMs: 16 * HOUR_MS }),
    ).toBe('16 hours left')
    expect(formatSlaSpoken({ _tag: 'DueSoon', remainingMs: 4 * HOUR_MS })).toBe(
      'due soon, 4 hours left',
    )
    expect(formatSlaSpoken({ _tag: 'Overdue', overdueMs: 3 * HOUR_MS })).toBe(
      'overdue by 3 hours',
    )
  })

  test('the compact form says late instead of overdue to fit narrow screens', () => {
    expect(formatSlaCompact({ _tag: 'Overdue', overdueMs: 20 * HOUR_MS })).toBe(
      '20h 0m late',
    )
    expect(
      formatSlaCompact({ _tag: 'OnTrack', remainingMs: 26 * HOUR_MS }),
    ).toBe('1d 2h left')
  })
})

describe('hero layout', () => {
  test('narrow screens get the timeline, wider ones the axis', () => {
    expect(heroLayoutForViewport(true)).toBe('Timeline')
    expect(heroLayoutForViewport(false)).toBe('Axis')
  })

  test('only a change between two drawn layouts animates', () => {
    expect(isAnimatedLayoutChange('Responsive', 'Timeline')).toBe(false)
    expect(isAnimatedLayoutChange('Axis', 'Axis')).toBe(false)
    expect(isAnimatedLayoutChange('Axis', 'Timeline')).toBe(true)
    expect(isAnimatedLayoutChange('Timeline', 'Axis')).toBe(true)
  })

  test('each layout has its own control id per case', () => {
    expect(markDomId('Axis', 'SYN-001')).toBe('axis-case-SYN-001')
    expect(markDomId('Timeline', 'SYN-001')).toBe('timeline-case-SYN-001')
  })
})
