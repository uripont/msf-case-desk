import { describe, expect, test } from 'vitest'

import {
  DEFAULT_RULES,
  DEMO_START,
  SEED_CASES,
  countByPriority,
  prioritise,
  slaStatus,
} from './index'

const HOUR_MS = 3_600_000

describe('queue', () => {
  const queue = prioritise(DEFAULT_RULES, SEED_CASES, DEMO_START)

  test('keeps every case', () => {
    expect(queue.length).toBe(SEED_CASES.length)
  })

  test('sorts P1 first and then by due time', () => {
    const ranks = queue.map(triaged => triaged.result.priority)
    expect(ranks).toEqual([...ranks].sort())
    queue.forEach((triaged, index) => {
      const next = queue[index + 1]
      if (
        next !== undefined &&
        next.result.priority === triaged.result.priority
      ) {
        expect(triaged.result.dueAt).toBeLessThanOrEqual(next.result.dueAt)
      }
    })
  })

  test('the seed data covers all three priorities', () => {
    expect(countByPriority(queue, 'P1')).toBeGreaterThan(0)
    expect(countByPriority(queue, 'P2')).toBeGreaterThan(0)
    expect(countByPriority(queue, 'P3')).toBeGreaterThan(0)
  })

  test('the sla status moves from on track to overdue', () => {
    const dueAt = 100 * HOUR_MS
    expect(slaStatus(dueAt, 0)._tag).toBe('OnTrack')
    expect(slaStatus(dueAt, dueAt - 3 * HOUR_MS)._tag).toBe('DueSoon')
    expect(slaStatus(dueAt, dueAt + 1)._tag).toBe('Overdue')
  })

  test('advancing the clock only makes cases later', () => {
    const later = prioritise(
      DEFAULT_RULES,
      SEED_CASES,
      DEMO_START + 24 * HOUR_MS,
    )
    const overdueNow = queue.filter(
      triaged => triaged.sla._tag === 'Overdue',
    ).length
    const overdueLater = later.filter(
      triaged => triaged.sla._tag === 'Overdue',
    ).length
    expect(overdueLater).toBeGreaterThanOrEqual(overdueNow)
  })
})
