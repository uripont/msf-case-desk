import { Effect } from 'effect'
import type { RpcGroup } from 'effect/rpc'

import {
  type QuoroomPublicRpcs,
  LinkInvalid,
  Repository,
} from '@case-desk/domain'

import { hashPassword } from '../password'
import { SESSION_DAYS, hashToken, sessionCookie } from '../session'
import { meFor } from './accounts'
import { authenticate } from './signin'
import { setCookie } from './cookies'
import { QuoroomClock, fromRepository, randomToken, store } from './core'

// NOTE: The public group (D13): no session. Sign-in is throttled before the
// password is hashed. An unknown email, a wrong password and an account
// without a password all answer `InvalidCredentials` and cost the same
// hashing. Links answer `LinkInvalid` whether unknown, used or expired. A
// link that sets a password also ends every session of the account and signs
// the person in; the cookie is set by the Worker, never put in a body.

type PublicHandlers = RpcGroup.HandlersFrom<RpcGroup.Rpcs<typeof QuoroomPublicRpcs>>

const SESSION_MS = SESSION_DAYS * 24 * 3_600_000

const startSession = (
  headers: Readonly<Record<string, string | undefined>>,
  userId: string,
  now: number,
) =>
  Effect.gen(function* () {
    const repository = yield* Repository
    const token = randomToken()
    const expiresAt = now + SESSION_MS
    yield* fromRepository(
      repository.createSession({
        tokenHash: yield* Effect.promise(() => hashToken(token)),
        userId: userId as never,
        createdAt: now,
        expiresAt,
      }),
    )
    setCookie(headers, sessionCookie(token, expiresAt))
  })

const usable = (invitation: {
  usedAt: number | null
  expiresAt: number
}, now: number): boolean => invitation.usedAt === null && invitation.expiresAt > now

export const publicHandlers: PublicHandlers = {
  SignIn: ({ email, password }, { headers }) =>
    Effect.gen(function* () {
      const db = yield* store
      const { account, now } = yield* authenticate(email, password, headers)
      yield* startSession(headers, account.id, now)
      return yield* meFor(db, account.id)
    }),

  InspectLink: ({ token }) =>
    Effect.gen(function* () {
      const db = yield* store
      const clock = yield* QuoroomClock
      const now = yield* clock.now
      const hash = yield* Effect.promise(() => hashToken(token))
      const invitation = yield* db.findInvitation(hash)
      if (invitation === null || !usable(invitation, now)) {
        return yield* Effect.fail(new LinkInvalid())
      }
      const account = yield* db.getAccount(invitation.userId)
      if (account === null) return yield* Effect.fail(new LinkInvalid())
      return {
        purpose: invitation.purpose,
        name: account.name,
        email: account.email,
        expiresAt: invitation.expiresAt,
      }
    }),

  // NOTE: one use. The password is set, every session of the account ends and
  // the link is marked used in one batch (`consumeInvitation`); then the
  // person is signed in with a new session.
  ConsumeLink: ({ token, password }, { headers }) =>
    Effect.gen(function* () {
      const db = yield* store
      const clock = yield* QuoroomClock
      const now = yield* clock.now
      const hash = yield* Effect.promise(() => hashToken(token))
      const invitation = yield* db.findInvitation(hash)
      if (invitation === null || !usable(invitation, now)) {
        return yield* Effect.fail(new LinkInvalid())
      }
      const passwordHash = yield* Effect.promise(() => hashPassword(password))
      const consumed = yield* db.consumeInvitation(hash, passwordHash, now, {
        at: now,
        actorId: invitation.userId,
        action:
          invitation.purpose === 'activate'
            ? 'account.activated'
            : 'account.password_reset',
        meta: JSON.stringify({ accountId: invitation.userId }),
      })
      if (consumed._tag === 'Refused') {
        return yield* Effect.fail(new LinkInvalid())
      }
      yield* startSession(headers, consumed.userId, now)
      return yield* meFor(db, consumed.userId)
    }),
}
