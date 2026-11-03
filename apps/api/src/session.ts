import { Clock, Effect, Option, Schema } from 'effect'

import {
  Email,
  Repository,
  type RepositoryError,
  type User,
} from '@case-desk/domain'

import { DUMMY_HASH, verifyPassword } from './password'

export const SESSION_COOKIE = 'case_desk_session'
export const SESSION_DAYS = 14
const SESSION_MS = SESSION_DAYS * 24 * 3_600_000

export const Credentials = Schema.Struct({
  email: Email,
  password: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200)),
})
export type Credentials = typeof Credentials.Type

const toHex = (bytes: ArrayBuffer): string =>
  Array.from(new Uint8Array(bytes), byte =>
    byte.toString(16).padStart(2, '0'),
  ).join('')

// NOTE: only the SHA-256 of a session token is stored, so a copy of the
// database cannot be used to sign in.
export const hashToken = (token: string): Promise<string> =>
  crypto.subtle.digest('SHA-256', new TextEncoder().encode(token)).then(toHex)

const newToken = (): string =>
  toHex(crypto.getRandomValues(new Uint8Array(32)).buffer)

export type SignIn = Readonly<{
  user: User
  token: string
  expiresAt: number
}>

export const signIn = (
  credentials: Credentials,
): Effect.Effect<Option.Option<SignIn>, RepositoryError, Repository> =>
  Effect.gen(function* () {
    const repository = yield* Repository
    const maybeUser = yield* repository.findUserByEmail(credentials.email)
    const storedHash = Option.match(maybeUser, {
      onNone: () => DUMMY_HASH,
      onSome: user => user.passwordHash,
    })
    const isValid = yield* Effect.promise(() =>
      verifyPassword(credentials.password, storedHash),
    )
    if (!isValid || Option.isNone(maybeUser)) {
      return Option.none()
    }
    const { id, email, name } = maybeUser.value
    const now = yield* Clock.currentTimeMillis
    const token = newToken()
    const expiresAt = now + SESSION_MS
    yield* repository.createSession({
      tokenHash: yield* Effect.promise(() => hashToken(token)),
      userId: id,
      createdAt: now,
      expiresAt,
    })
    return Option.some({ user: { id, email, name }, token, expiresAt })
  })

export const sessionUser = (
  token: string,
): Effect.Effect<Option.Option<User>, RepositoryError, Repository> =>
  Effect.gen(function* () {
    const repository = yield* Repository
    const now = yield* Clock.currentTimeMillis
    const tokenHash = yield* Effect.promise(() => hashToken(token))
    return yield* repository.findSessionUser(tokenHash, now)
  })

export const signOut = (
  token: string,
): Effect.Effect<void, RepositoryError, Repository> =>
  Effect.gen(function* () {
    const repository = yield* Repository
    const tokenHash = yield* Effect.promise(() => hashToken(token))
    yield* repository.deleteSession(tokenHash)
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
