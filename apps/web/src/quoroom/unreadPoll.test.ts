import { Effect, Fiber, Option, Stream } from 'effect'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

import {
  POLL_MAX_SECONDS,
  POLL_MIN_SECONDS,
  nextPollDelay,
  pollUnread,
} from './unreadPoll'

describe('nextPollDelay', () => {
  test('doubles while the count does not change, up to five minutes, and starts again on a change or a return', () => {
    let seconds = POLL_MIN_SECONDS
    const seen: Array<number> = []
    for (let index = 0; index < 6; index += 1) {
      seconds = nextPollDelay(seconds, { changed: false, returned: false })
      seen.push(seconds)
    }
    expect(seen).toEqual([60, 120, 240, POLL_MAX_SECONDS, POLL_MAX_SECONDS, POLL_MAX_SECONDS])
    expect(nextPollDelay(240, { changed: true, returned: false })).toBe(POLL_MIN_SECONDS)
    expect(nextPollDelay(240, { changed: false, returned: true })).toBe(POLL_MIN_SECONDS)
  })
})

describe('pollUnread in a tab', () => {
  const setHidden = (hidden: boolean) => {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden })
    document.dispatchEvent(new Event('visibilitychange'))
  }

  beforeEach(() => {
    vi.useFakeTimers()
    setHidden(false)
  })
  afterEach(() => {
    vi.useRealTimers()
    setHidden(false)
  })

  const start = () => {
    let reads = 0
    const counts: Array<number> = []
    const fiber = Effect.runFork(
      Stream.runForEach(
        pollUnread(
          Effect.sync(() => {
            reads += 1
            return Option.some(3)
          }),
        ),
        count => Effect.sync(() => void counts.push(count)),
      ),
    )
    return { reads: () => reads, counts, stop: () => Effect.runPromise(Fiber.interrupt(fiber)) }
  }

  test('asks at once, then slows down while the count stays the same', async () => {
    const poll = start()
    await vi.advanceTimersByTimeAsync(1)
    expect(poll.reads()).toBe(1)
    await vi.advanceTimersByTimeAsync(30_000)
    expect(poll.reads()).toBe(2)
    // The first answer changed the count (from nothing): 30 s. The second did not: 60 s.
    await vi.advanceTimersByTimeAsync(30_000)
    expect(poll.reads()).toBe(2)
    await vi.advanceTimersByTimeAsync(30_000)
    expect(poll.reads()).toBe(3)
    await poll.stop()
  })

  test('does not ask while the tab is hidden, and asks at once when it is shown', async () => {
    const poll = start()
    await vi.advanceTimersByTimeAsync(1)
    expect(poll.reads()).toBe(1)
    setHidden(true)
    await vi.advanceTimersByTimeAsync(20 * 60_000)
    expect(poll.reads()).toBe(1)
    setHidden(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(poll.reads()).toBe(2)
    await poll.stop()
  })

  test('asks at once when the window is focused', async () => {
    const poll = start()
    await vi.advanceTimersByTimeAsync(1)
    await vi.advanceTimersByTimeAsync(30_000)
    expect(poll.reads()).toBe(2)
    window.dispatchEvent(new Event('focus'))
    await vi.advanceTimersByTimeAsync(1)
    expect(poll.reads()).toBe(3)
    await poll.stop()
  })
})
