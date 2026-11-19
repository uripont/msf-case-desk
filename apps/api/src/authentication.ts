import { Effect, Layer, Option } from 'effect'

import {
  Authentication,
  CurrentUser,
  Repository,
  Unauthorised,
} from '@quoroom/domain'

import { sessionUser, tokenFromCookies } from './session'

// NOTE: every signed-in procedure reads the session cookie the browser sends
// with each request and gets the account as `CurrentUser`.
export const AuthenticationLive = Layer.effect(
  Authentication,
  Effect.gen(function* () {
    const repository = yield* Repository
    return Authentication.of((effect, { headers }) =>
      Option.match(tokenFromCookies(headers['cookie'] ?? null), {
        onNone: () => Effect.fail(new Unauthorised()),
        onSome: token =>
          sessionUser(token).pipe(
            Effect.provideService(Repository, repository),
            Effect.mapError(() => new Unauthorised()),
            Effect.flatMap(maybeUser =>
              Option.match(maybeUser, {
                onNone: () => Effect.fail(new Unauthorised()),
                onSome: user =>
                  Effect.provideService(effect, CurrentUser, user),
              }),
            ),
          ),
      }),
    )
  }),
)
