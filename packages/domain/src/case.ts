import { Schema } from 'effect'

import { Tolerant } from './compat'

export const CaseId = Schema.NonEmptyString.pipe(Schema.brand('CaseId'))
export type CaseId = typeof CaseId.Type

export const OperationalCentre = Schema.Literals([
  'OCA',
  'OCB',
  'OCBA',
  'OCG',
  'OCP',
])
export type OperationalCentre = typeof OperationalCentre.Type

export const Channel = Schema.Literals([
  'IntegrityLine',
  'Email',
  'LineManager',
  'PartnerOrganisation',
])
export type Channel = typeof Channel.Type

export const Scope = Schema.Literals(['Individual', 'Team', 'Systemic'])
export type Scope = typeof Scope.Type

export const Risk = Schema.Literals(['Low', 'Medium', 'High'])
export type Risk = typeof Risk.Type

export const Urgency = Schema.Literals(['Routine', 'Elevated', 'Immediate'])
export type Urgency = typeof Urgency.Type

export const FastTrackSignal = Schema.Literals([
  'ImmediatePhysicalSafety',
  'Exploitation',
  'Retaliation',
])
export type FastTrackSignal = typeof FastTrackSignal.Type

// NOTE: Case is the reader for stored cases. Its enums are tolerant, so a
// value added by a newer version decodes as 'Unknown' instead of failing.
export const Case = Schema.Struct({
  id: CaseId,
  summary: Schema.NonEmptyString,
  centre: Tolerant(OperationalCentre),
  channel: Tolerant(Channel),
  receivedAt: Schema.Int,
  scope: Tolerant(Scope),
  risk: Tolerant(Risk),
  urgency: Tolerant(Urgency),
  fastTrackSignals: Schema.Array(Tolerant(FastTrackSignal)),
})
export type Case = typeof Case.Type

export const CENTRES: ReadonlyArray<OperationalCentre> =
  OperationalCentre.literals
export const SCOPES: ReadonlyArray<Scope> = Scope.literals
export const RISKS: ReadonlyArray<Risk> = Risk.literals
export const URGENCIES: ReadonlyArray<Urgency> = Urgency.literals
export const FAST_TRACK_SIGNALS: ReadonlyArray<FastTrackSignal> =
  FastTrackSignal.literals
