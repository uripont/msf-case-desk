import { Array, Option, Result, Schema, pipe } from 'effect'
import { defineTaggedUnion } from 'foldkit/schema'
import { modifyFields } from 'foldkit/struct'

import {
  type Case,
  CaseEntry,
  CaseId,
  Channel,
  FastTrackSignal,
  OperationalCentre,
  Risk,
  type RuleSet,
  Scope,
  type TriageResult,
  Urgency,
  decodeCaseEntry,
  rulesFor,
  triage,
} from '@case-desk/domain'

import { ApiFailure } from './api'

// MODEL

export const EntrySubmission = defineTaggedUnion({
  Editing: {},
  Submitting: {},
  Failed: { failure: ApiFailure },
})
export type EntrySubmission = typeof EntrySubmission.Type

export const EntryForm = Schema.Struct({
  centre: OperationalCentre,
  channel: Channel,
  receivedAt: Schema.String,
  summary: Schema.String,
  details: Schema.String,
  location: Schema.String,
  reference: Schema.String,
  scope: Scope,
  risk: Risk,
  urgency: Urgency,
  fastTrackSignals: Schema.Array(FastTrackSignal),
  isShowingErrors: Schema.Boolean,
  submission: EntrySubmission,
})
export type EntryForm = typeof EntryForm.Type

export const EntryField = Schema.Literals([
  'centre',
  'channel',
  'receivedAt',
  'summary',
  'details',
  'location',
  'reference',
  'scope',
  'risk',
  'urgency',
  'fastTrackSignals',
])
export type EntryField = typeof EntryField.Type

// NOTE: the datetime-local input has no time zone. Case Desk shows times in
// UTC everywhere, so the field is read and written as UTC.
export const toDateTimeInput = (instant: number): string =>
  new Date(instant).toISOString().slice(0, 16)

export const fromDateTimeInput = (value: string): Option.Option<number> =>
  pipe(
    Option.liftPredicate(value, text =>
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(text),
    ),
    Option.map(text => Date.parse(`${text}:00Z`)),
    Option.filter(Number.isFinite),
  )

export const emptyEntryForm = (now: number): EntryForm =>
  EntryForm.make({
    centre: 'OCBA',
    channel: 'IntegrityLine',
    receivedAt: toDateTimeInput(now),
    summary: '',
    details: '',
    location: '',
    reference: '',
    scope: 'Individual',
    risk: 'Low',
    urgency: 'Routine',
    fastTrackSignals: [],
    isShowingErrors: false,
    submission: EntrySubmission.Editing(),
  })

// VALIDATION

export type EntryErrors = Partial<Record<EntryField, string>>

const optionalText = (value: string) => {
  const trimmed = value.trim()
  return trimmed === '' ? {} : { value: trimmed }
}

export const entryErrorsOf = (form: EntryForm, now: number): EntryErrors => ({
  ...(form.summary.trim() === ''
    ? { summary: 'Write a short summary of what was reported.' }
    : {}),
  ...(form.summary.trim().length > 500
    ? { summary: 'Keep the summary under 500 characters.' }
    : {}),
  ...(form.details.trim().length > 4000
    ? { details: 'Keep the details under 4,000 characters.' }
    : {}),
  ...(form.location.trim().length > 120
    ? { location: 'Keep the location under 120 characters.' }
    : {}),
  ...(form.reference.trim().length > 120
    ? { reference: 'Keep the reference under 120 characters.' }
    : {}),
  ...Option.match(fromDateTimeInput(form.receivedAt), {
    onNone: () => ({ receivedAt: 'Enter the date and time it was received.' }),
    onSome: receivedAt =>
      receivedAt > now + 3_600_000
        ? { receivedAt: 'The date received cannot be in the future.' }
        : {},
  }),
})

export const entryOf = (
  form: EntryForm,
  now: number,
): Result.Result<CaseEntry, EntryErrors> => {
  const errors = entryErrorsOf(form, now)
  if (Object.keys(errors).length > 0) {
    return Result.fail(errors)
  }
  const details = optionalText(form.details)
  const location = optionalText(form.location)
  const reference = optionalText(form.reference)
  return pipe(
    decodeCaseEntry({
      centre: form.centre,
      channel: form.channel,
      receivedAt: Option.getOrElse(fromDateTimeInput(form.receivedAt), () => 0),
      summary: form.summary.trim(),
      scope: form.scope,
      risk: form.risk,
      urgency: form.urgency,
      fastTrackSignals: form.fastTrackSignals,
      ...('value' in details ? { details: details.value } : {}),
      ...('value' in location ? { location: location.value } : {}),
      ...('value' in reference ? { reference: reference.value } : {}),
    }),
    Result.mapError((): EntryErrors => ({
      summary: 'Some of the entry could not be read. Check every field.',
    })),
  )
}

export const toggleSignal = (
  form: EntryForm,
  signal: FastTrackSignal,
): EntryForm =>
  modifyFields(form, {
    fastTrackSignals: signals =>
      Array.contains(signals, signal)
        ? Array.filter(signals, existing => existing !== signal)
        : Array.append(signals, signal),
  })

// NOTE: the priority the case would get with its centre's current rules,
// shown while the form is filled in.
export const previewOf = (
  form: EntryForm,
  ruleSets: ReadonlyArray<RuleSet>,
  now: number,
): TriageResult => {
  const draft: Case = {
    id: CaseId.make('NEW'),
    summary: 'Draft',
    centre: form.centre,
    receivedAt: Option.getOrElse(fromDateTimeInput(form.receivedAt), () => now),
    scope: form.scope,
    risk: form.risk,
    urgency: form.urgency,
    fastTrackSignals: form.fastTrackSignals,
    channel: form.channel,
    details: '',
    location: '',
    reference: '',
    enteredAt: now,
    enteredByName: '',
    schemaVersion: 1,
  }
  return triage(rulesFor(ruleSets, form.centre), draft)
}
