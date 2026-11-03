import { Clock, Effect, Layer, Option } from 'effect'

import {
  Authentication,
  CaseDeskRpcs,
  CaseId,
  CaseNotFound,
  CurrentUser,
  Repository,
  type RepositoryError,
  StorageUnavailable,
  Unauthorised,
} from '@case-desk/domain'

import { sessionUser, tokenFromCookies } from './session'

const toStorageUnavailable = (error: RepositoryError) =>
  new StorageUnavailable({ message: error.message })

const newCaseId = Effect.sync(() =>
  CaseId.make(`CD-${crypto.randomUUID().slice(0, 8).toUpperCase()}`),
)

const orNotFound =
  (id: string) =>
  <A>(maybeFound: Option.Option<A>) =>
    Option.match(maybeFound, {
      onNone: () => Effect.fail(new CaseNotFound({ id })),
      onSome: Effect.succeed,
    })

export const CaseDeskHandlers = CaseDeskRpcs.toLayer(
  Effect.gen(function* () {
    const repository = yield* Repository

    return CaseDeskRpcs.of({
      ListCases: () =>
        repository.listCases().pipe(Effect.mapError(toStorageUnavailable)),
      GetCase: ({ id }) =>
        repository
          .getCase(id)
          .pipe(
            Effect.mapError(toStorageUnavailable),
            Effect.flatMap(orNotFound(id)),
          ),
      CreateCase: ({ entry }) =>
        Effect.gen(function* () {
          const user = yield* CurrentUser
          const enteredAt = yield* Clock.currentTimeMillis
          const id = yield* newCaseId
          return yield* repository.createCase({
            id,
            entry,
            enteredAt,
            enteredBy: user.id,
          })
        }).pipe(Effect.mapError(toStorageUnavailable)),
      UpdateCase: ({ id, patch }) =>
        repository
          .updateCase(id, patch)
          .pipe(
            Effect.mapError(toStorageUnavailable),
            Effect.flatMap(orNotFound(id)),
          ),
      ListRuleSets: () =>
        repository.listRuleSets().pipe(Effect.mapError(toStorageUnavailable)),
      PutRuleSet: ({ scope, rules }) =>
        Effect.gen(function* () {
          const user = yield* CurrentUser
          const updatedAt = yield* Clock.currentTimeMillis
          return yield* repository.putRuleSet(scope, rules, updatedAt, user.id)
        }).pipe(Effect.mapError(toStorageUnavailable)),
    })
  }),
)

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
