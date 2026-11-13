import { Array, Effect, Layer, Option, Ref, Schema, pipe } from 'effect'

import { Case } from '../case'
import type { CasePatch } from '../entry'
import {
  type NewSession,
  Repository,
  caseFromEntry,
} from '../repository'
import type { RuleSet, RuleSetScope, TriageRules } from '../rules'
import { type User, type UserId, type UserRecord, normaliseEmail } from '../user'

// NOTE: the in-memory twin of the iteration 2 `Repository`, for tests only.
// It is not exported from the package index, so no app bundles it.

const decodeCase = Schema.decodeUnknownSync(Case)

type StoredRuleSet = Readonly<{
  scope: RuleSetScope
  rules: TriageRules
  updatedAt: number
  updatedBy: UserId | undefined
}>

type StoredSession = NewSession

type MemoryState = Readonly<{
  cases: ReadonlyArray<Case>
  ruleSets: ReadonlyArray<StoredRuleSet>
  users: ReadonlyArray<UserRecord>
  sessions: ReadonlyArray<StoredSession>
}>

const toUser = ({ id, email, name }: UserRecord): User => ({ id, email, name })

export const makeMemoryRepository = (
  seed: Partial<MemoryState> = {},
): Effect.Effect<Repository['Service']> =>
  Effect.gen(function* () {
    const state = yield* Ref.make<MemoryState>({
      cases: seed.cases ?? [],
      ruleSets: seed.ruleSets ?? [],
      users: seed.users ?? [],
      sessions: seed.sessions ?? [],
    })

    const nameOf = (current: MemoryState, userId?: UserId): string =>
      pipe(
        Array.findFirst(current.users, user => user.id === userId),
        Option.match({ onNone: () => '', onSome: user => user.name }),
      )

    const toRuleSet = (
      current: MemoryState,
      stored: StoredRuleSet,
    ): RuleSet => ({
      scope: stored.scope,
      rules: stored.rules,
      updatedAt: stored.updatedAt,
      updatedByName: nameOf(current, stored.updatedBy),
    })

    return Repository.of({
      listCases: () => Effect.map(Ref.get(state), current => current.cases),
      getCase: id =>
        Effect.map(Ref.get(state), current =>
          Array.findFirst(current.cases, stored => stored.id === id),
        ),
      createCase: newCase =>
        Ref.modify(state, current => {
          const created = caseFromEntry(
            newCase,
            nameOf(current, newCase.enteredBy),
          )
          return [created, { ...current, cases: [...current.cases, created] }]
        }),
      updateCase: (id, patch) =>
        Ref.modify(state, current => {
          const maybeUpdated = pipe(
            Array.findFirst(current.cases, stored => stored.id === id),
            Option.map(stored => decodeCase({ ...stored, ...patch })),
          )
          return [
            maybeUpdated,
            Option.match(maybeUpdated, {
              onNone: () => current,
              onSome: updated => ({
                ...current,
                cases: Array.map(current.cases, stored =>
                  stored.id === id ? updated : stored,
                ),
              }),
            }),
          ]
        }),
      listRuleSets: () =>
        Effect.map(Ref.get(state), current =>
          Array.map(current.ruleSets, stored => toRuleSet(current, stored)),
        ),
      putRuleSet: (scope, rules, updatedAt, updatedBy) =>
        Ref.modify(state, current => {
          const stored: StoredRuleSet = { scope, rules, updatedAt, updatedBy }
          const next = {
            ...current,
            ruleSets: [
              ...Array.filter(current.ruleSets, set => set.scope !== scope),
              stored,
            ],
          }
          return [toRuleSet(next, stored), next]
        }),
      findUserByEmail: email =>
        Effect.map(Ref.get(state), current =>
          Array.findFirst(
            current.users,
            user => user.email === normaliseEmail(email),
          ),
        ),
      createUser: user =>
        Ref.modify(state, current => [
          toUser(user),
          {
            ...current,
            users: [
              ...current.users,
              { ...user, email: normaliseEmail(user.email) },
            ],
          },
        ]),
      createSession: session =>
        Ref.update(state, current => ({
          ...current,
          sessions: [...current.sessions, session],
        })),
      findSessionUser: (tokenHash, now) =>
        Effect.map(Ref.get(state), current =>
          pipe(
            Array.findFirst(
              current.sessions,
              session =>
                session.tokenHash === tokenHash && session.expiresAt > now,
            ),
            Option.flatMap(session =>
              Array.findFirst(
                current.users,
                user => user.id === session.userId,
              ),
            ),
            Option.map(toUser),
          ),
        ),
      deleteSession: tokenHash =>
        Ref.update(state, current => ({
          ...current,
          sessions: Array.filter(
            current.sessions,
            session => session.tokenHash !== tokenHash,
          ),
        })),
    })
  })

export const layerMemory = (
  seed: Partial<MemoryState> = {},
): Layer.Layer<Repository> =>
  Layer.effect(Repository, makeMemoryRepository(seed))
