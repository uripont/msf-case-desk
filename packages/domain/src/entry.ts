import { Schema } from 'effect'

import {
  Channel,
  FastTrackSignal,
  OperationalCentre,
  Risk,
  Scope,
  Urgency,
} from './case'

// NOTE: This file holds the whole list of fields a person enters for a case.
// The fields are provisional until the unit confirms its data format. The
// shared database is already live, so later changes must be additive: new
// optional fields, never a rename or a new type for an existing one.

export const ENTRY_SCHEMA_VERSION = 1

export const SUMMARY_MAX_LENGTH = 500
export const DETAILS_MAX_LENGTH = 4000
export const SHORT_TEXT_MAX_LENGTH = 120

const Text = (maxLength: number) =>
  Schema.Trimmed.check(Schema.isMaxLength(maxLength))

export const CaseEntry = Schema.Struct({
  centre: OperationalCentre,
  receivedAt: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  summary: Text(SUMMARY_MAX_LENGTH).check(Schema.isNonEmpty()),
  scope: Scope,
  risk: Risk,
  urgency: Urgency,
  fastTrackSignals: Schema.Array(FastTrackSignal).check(Schema.isUnique()),
  channel: Channel,
  details: Schema.optionalKey(Text(DETAILS_MAX_LENGTH)),
  location: Schema.optionalKey(Text(SHORT_TEXT_MAX_LENGTH)),
  reference: Schema.optionalKey(Text(SHORT_TEXT_MAX_LENGTH)),
})
export type CaseEntry = typeof CaseEntry.Type

export const decodeCaseEntry = Schema.decodeUnknownResult(CaseEntry)
