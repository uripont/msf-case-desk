import { Effect, Layer, Option, Schema, pipe } from 'effect'

import {
  Repository,
  RepositoryError,
  type User,
  UserRecord,
  normaliseEmail,
} from '@case-desk/domain'

import { type SqlDatabase } from './sql'

// NOTE: the accounts and sessions on SQL (D1, or SQLite under workerd). The
// `users` and `sessions` tables keep the shape the frozen iteration 2 reads
// on the shared demo database.

const query = <A>(
  operation: string,
  run: () => Promise<A>,
): Effect.Effect<A, RepositoryError> =>
  Effect.tryPromise({
    try: run,
    catch: error =>
      new RepositoryError({
        message: `${operation} failed: ${error instanceof Error ? error.message : String(error)}`,
      }),
  })

const decodeUser = Schema.decodeUnknownOption(UserRecord)

const userFromRow = (row: Record<string, unknown> | null) =>
  pipe(
    Option.fromNullishOr(row),
    Option.flatMap(present =>
      decodeUser({
        id: present['id'],
        email: present['email'],
        name: present['name'],
        passwordHash: present['password_hash'],
      }),
    ),
  )

const toUser = ({ id, email, name }: UserRecord): User => ({ id, email, name })

export const makeSqlRepository = (db: SqlDatabase): Repository['Service'] =>
  Repository.of({
    findUserByEmail: email =>
      query('Finding a user', () =>
        db
          .prepare('SELECT * FROM users WHERE email = ?')
          .bind(normaliseEmail(email))
          .first(),
      ).pipe(Effect.map(userFromRow)),
    createUser: user =>
      query('Creating a user', () =>
        db
          .prepare(
            'INSERT INTO users (id, email, name, password_hash) VALUES (?, ?, ?, ?)',
          )
          .bind(
            user.id,
            normaliseEmail(user.email),
            user.name,
            user.passwordHash,
          )
          .run(),
      ).pipe(Effect.as(toUser({ ...user, email: normaliseEmail(user.email) }))),
    createSession: session =>
      query('Creating a session', () =>
        db
          .prepare(
            'INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)',
          )
          .bind(
            session.tokenHash,
            session.userId,
            session.createdAt,
            session.expiresAt,
          )
          .run(),
      ).pipe(Effect.asVoid),
    findSessionUser: (tokenHash, now) =>
      query('Finding a session', () =>
        db
          .prepare(
            `SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
            WHERE s.token_hash = ? AND s.expires_at > ?`,
          )
          .bind(tokenHash, now)
          .first(),
      ).pipe(Effect.map(row => Option.map(userFromRow(row), toUser))),
    deleteSession: tokenHash =>
      query('Deleting a session', () =>
        db
          .prepare('DELETE FROM sessions WHERE token_hash = ?')
          .bind(tokenHash)
          .run(),
      ).pipe(Effect.asVoid),
  })

export const layerSql = (db: SqlDatabase): Layer.Layer<Repository> =>
  Layer.succeed(Repository, makeSqlRepository(db))
