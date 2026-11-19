import { Clock, Effect, Option } from 'effect'

import {
  Repository,
  type RepositoryError,
  type User,
} from '@quoroom/domain'

import { sha256Hex } from './quoroom/content'

// NOTE: the session format is shared with the frozen iteration 2 on the demo
// database: the cookie name, the token (32 random bytes in hex) and its stored
// SHA-256. Changing any of them signs everyone out of one of the two.
export const SESSION_COOKIE = 'case_desk_session'
export const SESSION_DAYS = 14

// NOTE: only the SHA-256 of a session token is stored, so a copy of the
// database cannot be used to sign in.
export const hashToken = sha256Hex

export const sessionUser = (
  token: string,
): Effect.Effect<Option.Option<User>, RepositoryError, Repository> =>
  Effect.gen(function* () {
    const repository = yield* Repository
    const now = yield* Clock.currentTimeMillis
    const tokenHash = yield* Effect.promise(() => hashToken(token))
    return yield* repository.findSessionUser(tokenHash, now)
  })

export const tokenFromCookies = (
  header: string | null,
): Option.Option<string> =>
  Option.fromNullishOr(
    (header ?? '')
      .split(';')
      .map(part => part.trim().split('='))
      .find(([name]) => name === SESSION_COOKIE)?.[1],
  ).pipe(Option.filter(token => /^[0-9a-f]{64}$/.test(token)))

export const sessionCookie = (token: string, expiresAt: number): string =>
  [
    `${SESSION_COOKIE}=${token}`,
    'Path=/api',
    'HttpOnly',
    'Secure',
    'SameSite=Strict',
    `Expires=${new Date(expiresAt).toUTCString()}`,
  ].join('; ')

export const clearedSessionCookie = (): string =>
  [
    `${SESSION_COOKIE}=`,
    'Path=/api',
    'HttpOnly',
    'Secure',
    'SameSite=Strict',
    'Max-Age=0',
  ].join('; ')
