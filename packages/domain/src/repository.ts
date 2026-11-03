import {
  Array,
  Context,
  Effect,
  Layer,
  Option,
  Ref,
  Schema,
  pipe,
} from 'effect'

import { Case, type CaseId } from './case'
import { type CaseEntry, type CasePatch, ENTRY_SCHEMA_VERSION } from './entry'
import { type RuleSet, type RuleSetScope, type TriageRules } from './rules'
import { type User, type UserId, type UserRecord, normaliseEmail } from './user'

export class RepositoryError extends Schema.TaggedError<RepositoryError>()(
  'RepositoryError',
  { message: Schema.String },
) {}

export type NewCase = Readonly<{
  id: CaseId
  entry: CaseEntry
  enteredAt: number
  enteredBy?: UserId
}>

export type NewSession = Readonly<{
  tokenHash: string
  userId: UserId
  createdAt: number
  expiresAt: number
}>

type Result<A> = Effect.Effect<A, RepositoryError>

export class Repository extends Context.Service<
  Repository,
  {
    readonly listCases: () => Result<ReadonlyArray<Case>>
    readonly getCase: (id: CaseId) => Result<Option.Option<Case>>
    readonly createCase: (newCase: NewCase) => Result<Case>
    readonly updateCase: (
      id: CaseId,
      patch: CasePatch,
    ) => Result<Option.Option<Case>>
    readonly listRuleSets: () => Result<ReadonlyArray<RuleSet>>
    readonly putRuleSet: (
      scope: RuleSetScope,
      rules: TriageRules,
      updatedAt: number,
      updatedBy?: UserId,
    ) => Result<RuleSet>
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

const decodeCase = Schema.decodeUnknownSync(Case)

export const caseFromEntry = (newCase: NewCase, enteredByName: string): Case =>
  decodeCase({
    id: newCase.id,
    ...newCase.entry,
    enteredAt: newCase.enteredAt,
    enteredByName,
    schemaVersion: ENTRY_SCHEMA_VERSION,
  })

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
