import { Effect, Option } from 'effect'

import {
  type AccountRecord,
  InvalidCredentials,
  Repository,
  StorageUnavailable,
  Throttled,
  THROTTLE_WINDOW_MS,
  normaliseEmail,
  retryAfterSeconds,
} from '@case-desk/domain'

import { DUMMY_HASH, verifyPassword } from '../password'
import { UNUSABLE_PASSWORD_HASH } from '../links'
import {
  QuoroomClock,
  QuoroomNetwork,
  type Store,
  clientAddress,
  store,
} from './core'

// NOTE: The one place a password is checked for a sign-in (D13). The attempt
// is throttled before any hashing. An unknown email, a wrong password, an account without a password
// and a deactivated account all fail the same way and cost the same hashing.
// The outcome is recorded either way.

const fromRepository = <A>(
  effect: Effect.Effect<A, { readonly message: string }>,
): Effect.Effect<A, StorageUnavailable> =>
  effect.pipe(
    Effect.mapError(error => new StorageUnavailable({ message: error.message })),
  )

// NOTE: attempts older than the window no longer count, so they are removed,
// a bounded number at a time (one query), whenever one is recorded.
const PRUNE_BATCH = 50
const pruneAttempts = (db: Store, now: number) =>
  db.pruneSignInAttempts(now - THROTTLE_WINDOW_MS, PRUNE_BATCH)

export const authenticate = (
  email: string,
  password: string,
  headers: Readonly<Record<string, string | undefined>>,
) =>
  Effect.gen(function* () {
    const repository = yield* Repository
    const db = yield* store
    const clock = yield* QuoroomClock
    const now = yield* clock.now
    const address = normaliseEmail(email)
    // NOTE: the address is only read from where it can be trusted (D20);
    // a deployment without one has a single shared bucket.
    const network = yield* Effect.serviceOption(QuoroomNetwork)
    const ip = clientAddress(
      Option.getOrElse(network, () => ({ kind: 'self_hosted' }) as const),
      headers,
    )
    // NOTE: before any hashing. A refused attempt is not recorded, so
    // waiting is never made longer by asking.
    const summary = yield* db.signInSummary(address, ip, now - THROTTLE_WINDOW_MS)
    const wait = retryAfterSeconds(summary, now)
    if (wait !== undefined) {
      return yield* Effect.fail(new Throttled({ retryAfterSeconds: wait }))
    }
    const found = yield* fromRepository(repository.findUserByEmail(address))
    const stored =
      Option.isSome(found) && found.value.passwordHash !== UNUSABLE_PASSWORD_HASH
        ? found.value.passwordHash
        : DUMMY_HASH
    const matches = yield* Effect.promise(() => verifyPassword(password, stored))
    const account: AccountRecord | null = Option.isSome(found)
      ? yield* db.getAccount(found.value.id)
      : null
    if (
      !matches ||
      Option.isNone(found) ||
      found.value.passwordHash === UNUSABLE_PASSWORD_HASH ||
      account === null ||
      account.profile?.active === false
    ) {
      yield* db.recordSignInAttempt(address, ip, now, false)
      yield* pruneAttempts(db, now)
      return yield* Effect.fail(new InvalidCredentials())
    }
    yield* db.recordSignInAttempt(address, ip, now, true)
    yield* pruneAttempts(db, now)
    return { account, now }
  })
