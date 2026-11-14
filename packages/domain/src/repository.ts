import { Context, type Effect, type Option, Schema } from 'effect'

import type { User, UserId, UserRecord } from './user'

export class RepositoryError extends Schema.TaggedError<RepositoryError>()(
  'RepositoryError',
  { message: Schema.String },
) {}

export type NewSession = Readonly<{
  tokenHash: string
  userId: UserId
  createdAt: number
  expiresAt: number
}>

type Result<A> = Effect.Effect<A, RepositoryError>

// NOTE: the accounts and their sessions. Their tables (`users`, `sessions`)
// are shared with the frozen iteration 2 on the demo database, so an account
// signs in to both with the same password and session format. Everything
// else of Quoroom is in `ReportRepository`.
export class Repository extends Context.Service<
  Repository,
  {
    readonly findUserByEmail: (
      email: string,
    ) => Result<Option.Option<UserRecord>>
    readonly createUser: (user: UserRecord) => Result<User>
    readonly createSession: (session: NewSession) => Result<void>
    readonly findSessionUser: (
      tokenHash: string,
      now: number,
    ) => Result<Option.Option<User>>
    readonly deleteSession: (tokenHash: string) => Result<void>
  }
>()('Repository') {}
