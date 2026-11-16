import { describe, expect, test } from 'vitest'

import {
  IN_APP_TEXT,
  LEASE_MS,
  MAX_ATTEMPTS,
  MINUTE,
  NOTIFICATION_KINDS,
  isMessageKind,
  notificationLink,
  retryAt,
  retryDelay,
} from './index'

describe('what each notification says', () => {
  test('every kind with a recipient has a line, and the deadline has none', () => {
    const kinds = NOTIFICATION_KINDS.filter(isMessageKind)
    expect(kinds).toHaveLength(NOTIFICATION_KINDS.length - 1)
    expect(isMessageKind('deadline')).toBe(false)
    for (const kind of kinds) {
      expect(IN_APP_TEXT[kind].length).toBeGreaterThan(10)
    }
  })

  test('the lines never name a case or a report', () => {
    for (const kind of NOTIFICATION_KINDS.filter(isMessageKind)) {
      expect(IN_APP_TEXT[kind]).not.toMatch(/case|ethics|intake|investigation/i)
    }
  })

  test('links go to the revision for a reviewer and to the right screen for an author', () => {
    expect(notificationLink('review_request', 'rep-1', 2)).toBe('/r/rep-1/rev/2')
    expect(notificationLink('reminder_final', 'rep-1', 2)).toBe('/r/rep-1/rev/2')
    expect(notificationLink('revision_replaced', 'rep-1', 3)).toBe('/r/rep-1/rev/3')
    expect(notificationLink('review_received', 'rep-1', 2)).toBe('/r/rep-1/comments')
    expect(notificationLink('approval_received', 'rep-1', 2)).toBe('/r/rep-1/grid')
    expect(notificationLink('round_decided', 'rep-1', 2)).toBe('/r/rep-1')
    expect(notificationLink('removed_from_round', 'rep-1', 2)).toBe('/inbox')
    expect(notificationLink('review_request', 'a/b c', 1)).toBe('/r/a%2Fb%20c/rev/1')
  })
})

describe('retry', () => {
  test('one minute after the first failure, doubling, at most 15 minutes', () => {
    expect([1, 2, 3, 4, 5].map(retryDelay)).toEqual(
      [1, 2, 4, 8, 15].map(m => m * MINUTE),
    )
    expect(retryDelay(40)).toBe(15 * MINUTE)
  })

  test('a job that has used its attempts is a final failure', () => {
    expect(retryAt(1000, 1)).toBe(1000 + MINUTE)
    expect(retryAt(1000, MAX_ATTEMPTS - 1)).not.toBeNull()
    expect(retryAt(1000, MAX_ATTEMPTS)).toBeNull()
  })

  test('the lease is longer than a pass can take and shorter than the retry cap', () => {
    expect(LEASE_MS).toBeGreaterThan(MINUTE)
    expect(LEASE_MS).toBeLessThan(15 * MINUTE)
  })
})
