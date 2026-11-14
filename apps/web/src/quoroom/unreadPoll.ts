import { Duration, Effect, Option, Stream } from 'effect'

// NOTE: How the unread count is polled. Every open tab asks
// for the count, and each ask is a query against the Free plan's budget, so
// the poll is quiet when nobody is looking: it waits while the tab is hidden,
// slows from 30 seconds to 5 minutes while the count does not change, and asks
// at once, and again at 30 seconds, when the tab is shown or focused.

export const POLL_MIN_SECONDS = 30
export const POLL_MAX_SECONDS = 300

// NOTE: the wait before the next ask. A change in the count, or the person
// coming back to the tab, starts again at the shortest; an answer that is the
// same as the last doubles it, up to the longest.
export const nextPollDelay = (
  seconds: number,
  input: Readonly<{ changed: boolean; returned: boolean }>,
): number =>
  input.changed || input.returned
    ? POLL_MIN_SECONDS
    : Math.min(seconds * 2, POLL_MAX_SECONDS)

type State = Readonly<{
  seconds: number
  last: number | undefined
  started: boolean
}>

const isHidden = (): boolean =>
  typeof document !== 'undefined' && document.hidden

// NOTE: finishes when the tab is visible (at once if it is).
const untilVisible: Effect.Effect<void> = Effect.callback<void>(resume => {
  if (!isHidden()) {
    resume(Effect.void)
    return
  }
  const onChange = () => {
    if (!isHidden()) resume(Effect.void)
  }
  document.addEventListener('visibilitychange', onChange)
  return Effect.sync(() =>
    document.removeEventListener('visibilitychange', onChange),
  )
})

// NOTE: true when the tab was focused or shown (or hidden: then the next
// `untilVisible` holds the poll) before the wait was over.
const returned = Effect.callback<boolean>(resume => {
  if (typeof window === 'undefined' || typeof document === 'undefined') return
  const wake = () => resume(Effect.succeed(true))
  window.addEventListener('focus', wake)
  document.addEventListener('visibilitychange', wake)
  return Effect.sync(() => {
    window.removeEventListener('focus', wake)
    document.removeEventListener('visibilitychange', wake)
  })
})

const wait = (seconds: number): Effect.Effect<boolean> =>
  Effect.raceFirst(
    Effect.sleep(Duration.seconds(seconds)).pipe(Effect.as(false)),
    returned,
  )

// NOTE: the counts as they are read: one at once, then each after its wait. A
// read that fails says nothing; the next one tries again.
export const pollUnread = (
  read: Effect.Effect<Option.Option<number>>,
): Stream.Stream<number> =>
  Stream.unfold<State, Option.Option<number>, never, never>(
    { seconds: POLL_MIN_SECONDS, last: undefined, started: false },
    state =>
      Effect.gen(function* () {
        const back = state.started ? yield* wait(state.seconds) : false
        yield* untilVisible
        const unread = yield* read
        const changed = Option.isSome(unread) && unread.value !== state.last
        return [
          unread,
          {
            seconds: nextPollDelay(state.seconds, { changed, returned: back }),
            last: Option.isSome(unread) ? unread.value : state.last,
            started: true,
          },
        ] as const
      }),
  ).pipe(
    Stream.filter(Option.isSome),
    Stream.map(({ value }) => value),
  )
