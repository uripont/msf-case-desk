import { describe, expect, test } from 'vitest'

import {
  EMAIL_FAILURE_THRESHOLD,
  retryAfterSeconds,
  throttleDelayMs,
} from './index'

const summary = (failuresByEmail: number, last: number | null) => ({
  failuresByEmail,
  lastFailureByEmail: last,
  failuresByIp: 0,
  lastFailureByIp: null,
})

describe('sign-in throttling', () => {
  test('no delay below the threshold, then one minute, doubling, capped at fifteen', () => {
    const delays = [3, 4, 5, 6, 7, 8, 9, 10, 20].map(n =>
      throttleDelayMs(n, EMAIL_FAILURE_THRESHOLD),
    )
    expect(delays).toEqual([
      0, 0, 60_000, 120_000, 240_000, 480_000, 900_000, 900_000, 900_000,
    ])
  })

  test('the wait runs from the last failure and counts down', () => {
    expect(retryAfterSeconds(summary(4, 1000), 1000)).toBeUndefined()
    expect(retryAfterSeconds(summary(5, 1000), 1000)).toBe(60)
    expect(retryAfterSeconds(summary(5, 1000), 31_000)).toBe(30)
    expect(retryAfterSeconds(summary(5, 1000), 61_000)).toBeUndefined()
    expect(retryAfterSeconds(summary(6, 1000), 61_000)).toBe(60)
    expect(retryAfterSeconds(summary(30, 1000), 1000)).toBe(900)
  })

  test('the address is throttled later than the account, and the longer wait wins', () => {
    expect(
      retryAfterSeconds(
        {
          failuresByEmail: 0,
          lastFailureByEmail: null,
          failuresByIp: 19,
          lastFailureByIp: 5,
        },
        10,
      ),
    ).toBeUndefined()
    expect(
      retryAfterSeconds(
        {
          failuresByEmail: 5,
          lastFailureByEmail: 0,
          failuresByIp: 21,
          lastFailureByIp: 0,
        },
        0,
      ),
    ).toBe(120)
  })
})
