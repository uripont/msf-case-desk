import { Context, Schema } from 'effect'
import { RpcMiddleware } from 'effect/rpc'

import { type User } from './user'

// NOTE: the pieces of the API contract that every procedure shares. The web
// app and the API Worker bundle both sides from the same commit.

export class StorageUnavailable extends Schema.TaggedError<StorageUnavailable>()(
  'StorageUnavailable',
  { message: Schema.String },
) {}

export class Unauthorised extends Schema.TaggedError<Unauthorised>()(
  'Unauthorised',
  {},
) {}

export class CurrentUser extends Context.Service<CurrentUser, User>()(
  'CurrentUser',
) {}

// NOTE: every signed-in procedure needs a session. The server reads the
// session cookie the browser sends with each request.
export class Authentication extends RpcMiddleware.Service<
  Authentication,
  { provides: CurrentUser }
>()('Authentication', { error: Unauthorised }) {}
