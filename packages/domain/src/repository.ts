import { Context, type Effect, type Option, Schema } from 'effect'

import { Case, type CaseId } from './case'
import { type CaseEntry, type CasePatch, ENTRY_SCHEMA_VERSION } from './entry'
import { type RuleSet, type RuleSetScope, type TriageRules } from './rules'
import type { User, UserId, UserRecord } from './user'

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
