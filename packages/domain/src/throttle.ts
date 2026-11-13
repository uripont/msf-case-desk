import type { SignInSummary } from './report-repository'

// NOTE: Sign-in throttling (D13). Failures are counted in a sliding window,
// per email and per IP address. From the threshold on, each further failure
// doubles the wait, from one minute up to the window (15 minutes), counted
// from the last failure. It is checked before the password is hashed, so a
// guessing run costs the attacker waiting and costs the Worker no hashing.
// Pure: the time comes in.

export const THROTTLE_WINDOW_MS = 15 * 60 * 1000
export const THROTTLE_BASE_MS = 60 * 1000
export const THROTTLE_MAX_MS = THROTTLE_WINDOW_MS
export const EMAIL_FAILURE_THRESHOLD = 5
export const IP_FAILURE_THRESHOLD = 20

export const throttleDelayMs = (failures: number, threshold: number): number =>
  failures < threshold
    ? 0
    : Math.min(THROTTLE_MAX_MS, THROTTLE_BASE_MS * 2 ** (failures - threshold))

// NOTE: how long the caller must wait, in whole seconds between 1 and 900, or
// `undefined` when the attempt may go ahead.
export const retryAfterSeconds = (
  summary: SignInSummary,
  now: number,
): number | undefined => {
  const waits = [
    [summary.failuresByEmail, summary.lastFailureByEmail, EMAIL_FAILURE_THRESHOLD],
    [summary.failuresByIp, summary.lastFailureByIp, IP_FAILURE_THRESHOLD],
  ] as const
  let until = 0
  for (const [failures, last, threshold] of waits) {
    if (last === null) continue
    until = Math.max(until, last + throttleDelayMs(failures, threshold))
  }
  if (until <= now) return undefined
  return Math.min(900, Math.max(1, Math.ceil((until - now) / 1000)))
}
