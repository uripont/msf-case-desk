import { Clock, Effect, Option } from 'effect'

import {
  CaseDeskRpcs,
  CaseId,
  CaseNotFound,
  Repository,
  type RepositoryError,
  StorageUnavailable,
} from '@case-desk/domain'

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
          const enteredAt = yield* Clock.currentTimeMillis
          const id = yield* newCaseId
          return yield* repository.createCase({ id, entry, enteredAt })
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
          const updatedAt = yield* Clock.currentTimeMillis
          return yield* repository.putRuleSet(scope, rules, updatedAt)
        }).pipe(Effect.mapError(toStorageUnavailable)),
    })
  }),
)
