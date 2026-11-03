import { Schema } from 'effect'
import { Rpc, RpcGroup } from 'effect/rpc'

import { Case, CaseId } from './case'
import { CaseEntry, CasePatch } from './entry'
import { RuleSet, RuleSetScope, ValidTriageRules } from './rules'

// NOTE: the API contract shared by the web app and the API Worker. Each
// deployed version bundles both sides from the same commit.

export const RPC_PATH = '/api/rpc'

export class CaseNotFound extends Schema.TaggedError<CaseNotFound>()(
  'CaseNotFound',
  { id: Schema.String },
) {}

export class StorageUnavailable extends Schema.TaggedError<StorageUnavailable>()(
  'StorageUnavailable',
  { message: Schema.String },
) {}

export class CaseDeskRpcs extends RpcGroup.make(
  Rpc.make('ListCases', {
    success: Schema.Array(Case),
    error: StorageUnavailable,
  }),
  Rpc.make('GetCase', {
    payload: { id: CaseId },
    success: Case,
    error: Schema.Union([CaseNotFound, StorageUnavailable]),
  }),
  Rpc.make('CreateCase', {
    payload: { entry: CaseEntry },
    success: Case,
    error: StorageUnavailable,
  }),
  Rpc.make('UpdateCase', {
    payload: { id: CaseId, patch: CasePatch },
    success: Case,
    error: Schema.Union([CaseNotFound, StorageUnavailable]),
  }),
  Rpc.make('ListRuleSets', {
    success: Schema.Array(RuleSet),
    error: StorageUnavailable,
  }),
  Rpc.make('PutRuleSet', {
    payload: { scope: RuleSetScope, rules: ValidTriageRules },
    success: RuleSet,
    error: StorageUnavailable,
  }),
) {}
