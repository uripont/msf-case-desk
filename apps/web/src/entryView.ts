import { clsx } from 'clsx'
import { Array, Match, Option } from 'effect'
import { Html, HtmlBuilder } from 'foldkit/html'

import {
  CENTRES,
  CHANNELS,
  FAST_TRACK_SIGNALS,
  type FastTrackSignal,
  RISKS,
  SCOPES,
  URGENCIES,
  describeReason,
  priorityLabel,
} from '@case-desk/domain'

import { type ApiFailure } from './api'
import {
  type EntryErrors,
  type EntryField,
  type EntryForm,
  EntrySubmission,
  entryErrorsOf,
  previewOf,
} from './entryForm'
import { formatInstant, humanise } from './format'
import { Message, type Model, PAGE_HEADING_ID } from './main'
import {
  fieldClassName,
  labelClassName,
  primaryButtonClassName,
  textAreaClassName,
  textButtonClassName,
} from './style'

const signalLabel = (signal: FastTrackSignal): string =>
  Match.value(signal).pipe(
    Match.when('ImmediatePhysicalSafety', () => 'Immediate physical safety'),
    Match.when('Exploitation', () => 'Exploitation'),
    Match.when('Retaliation', () => 'Retaliation'),
    Match.exhaustive,
  )

const failureText = (failure: ApiFailure): string =>
  Match.value(failure).pipe(
    Match.when(
      'SignInRequired',
      () => 'Your session has ended. Sign in again.',
    ),
    Match.when(
      'Unavailable',
      () => 'The case could not be saved. Nothing was lost; try again.',
    ),
    Match.exhaustive,
  )

const fieldId = (field: EntryField): string => `entry-${field}`
const errorId = (field: EntryField): string => `entry-${field}-error`

const errorFor = (
  errors: EntryErrors,
  field: EntryField,
): Option.Option<string> => Option.fromNullishOr(errors[field])

const fieldError = (
  maybeError: Option.Option<string>,
  field: EntryField,
  h: HtmlBuilder<Message>,
): Html =>
  Option.match(maybeError, {
    onNone: () => h.empty,
    onSome: error =>
      h.p(
        [h.Id(errorId(field)), h.Class('text-base font-medium text-msf-red')],
        [error],
      ),
  })

const invalidAttributes = (
  maybeError: Option.Option<string>,
  field: EntryField,
  h: HtmlBuilder<Message>,
) =>
  Option.match(maybeError, {
    onNone: () => [h.AriaInvalid(false)],
    onSome: () => [h.AriaInvalid(true), h.AriaDescribedBy(errorId(field))],
  })

const textField = (
  form: EntryForm,
  errors: EntryErrors,
  field: 'summary' | 'location' | 'reference',
  label: string,
  hint: string,
  h: HtmlBuilder<Message>,
): Html => {
  const maybeError = errorFor(errors, field)
  return h.div(
    [h.Class('flex flex-col gap-2')],
    [
      h.label([h.Class(labelClassName), h.For(fieldId(field))], [label]),
      hint === ''
        ? h.empty
        : h.p([h.Class('-mt-1 text-sm text-msf-grey')], [hint]),
      h.input([
        h.Id(fieldId(field)),
        h.Type('text'),
        h.Value(form[field]),
        h.Class(fieldClassName),
        ...invalidAttributes(maybeError, field, h),
        h.OnInput(value => Message.UpdatedEntryField({ field, value })),
      ]),
      fieldError(maybeError, field, h),
    ],
  )
}

const selectField = <A extends string>(
  field: EntryField,
  label: string,
  selected: A,
  choices: ReadonlyArray<A>,
  toLabel: (choice: A) => string,
  h: HtmlBuilder<Message>,
): Html =>
  h.div(
    [h.Class('flex flex-col gap-2')],
    [
      h.label([h.Class(labelClassName), h.For(fieldId(field))], [label]),
      h.select(
        [
          h.Id(fieldId(field)),
          h.Value(selected),
          h.Class(fieldClassName),
          h.OnChange(value => Message.UpdatedEntryField({ field, value })),
        ],
        Array.map(choices, choice =>
          h.option(
            [h.Value(choice), h.Selected(choice === selected)],
            [toLabel(choice)],
          ),
        ),
      ),
    ],
  )

const signalsField = (form: EntryForm, h: HtmlBuilder<Message>): Html =>
  h.fieldset(
    [h.Class('flex flex-col gap-3 border-0 p-0')],
    [
      h.legend(
        [h.Class('pb-1 text-base font-medium text-msf-ink')],
        ['Fast-track signals'],
      ),
      h.p(
        [h.Class('-mt-1 text-sm text-msf-grey')],
        ['Any of these makes the case urgent with a 24 hour clock.'],
      ),
      ...Array.map(FAST_TRACK_SIGNALS, signal =>
        h.label(
          [
            h.Class('flex cursor-pointer items-center gap-3 text-lg'),
            h.For(`entry-signal-${signal}`),
          ],
          [
            h.input([
              h.Id(`entry-signal-${signal}`),
              h.Type('checkbox'),
              h.Class('size-5 accent-msf-red'),
              h.Checked(Array.contains(form.fastTrackSignals, signal)),
              h.OnClick(Message.ToggledEntrySignal({ signal })),
            ]),
            signalLabel(signal),
          ],
        ),
      ),
    ],
  )

const preview = (model: Model, h: HtmlBuilder<Message>): Html => {
  const result = previewOf(model.entryForm, model.ruleSets, model.now)
  return h.aside(
    [
      h.AriaLabel('Priority preview'),
      h.AriaLive('polite'),
      h.Class(
        'flex flex-col gap-3 border-t-2 border-msf-ink pt-4 lg:sticky lg:top-10 lg:self-start',
      ),
    ],
    [
      h.p(
        [h.Class('text-base text-msf-grey')],
        ['With these answers it would be'],
      ),
      h.p(
        [
          h.Class(
            clsx(
              'text-3xl font-black tracking-tight',
              result.priority === 'P1' ? 'text-msf-red' : 'text-msf-black',
            ),
          ),
        ],
        [
          `${priorityLabel(result.priority)}${result.isFastTrack ? ', fast-track' : ''}`,
        ],
      ),
      h.p(
        [h.Class('text-base tabular-nums text-msf-ink')],
        [
          `Assess by ${formatInstant(result.dueAt)}, ${result.targetHours} hours after it was received.`,
        ],
      ),
      h.ul(
        [
          h.Class(
            'm-0 flex list-none flex-col gap-1 p-0 text-base text-msf-grey',
          ),
        ],
        Array.map(result.reasons, reason => h.li([], [describeReason(reason)])),
      ),
    ],
  )
}

export const entryPage = (model: Model, h: HtmlBuilder<Message>): Html => {
  const form = model.entryForm
  const errors = form.isShowingErrors ? entryErrorsOf(form, model.now) : {}
  const isSubmitting = EntrySubmission.guards.Submitting(form.submission)
  const receivedError = errorFor(errors, 'receivedAt')
  const detailsError = errorFor(errors, 'details')

  return h.section(
    [
      h.AriaLabel('New case'),
      h.Class('flex flex-col gap-10 pb-14 pt-12 md:pt-16'),
    ],
    [
      h.div(
        [h.Class('flex flex-col gap-3')],
        [
          h.h1(
            [
              h.Id(PAGE_HEADING_ID),
              h.Class(
                'text-4xl font-black leading-[1.05] tracking-[-0.025em] text-msf-black sm:text-5xl',
              ),
            ],
            ['New case'],
          ),
          h.p(
            [h.Class('max-w-2xl text-pretty text-lg font-light text-msf-ink')],
            [
              'Record a case as it was received. Use synthetic details only in this prototype.',
            ],
          ),
        ],
      ),
      h.div(
        [
          h.Class(
            'grid gap-12 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)] xl:gap-20',
          ),
        ],
        [
          h.form(
            [
              h.Class('flex flex-col gap-6'),
              h.OnSubmit(Message.SubmittedEntry()),
            ],
            [
              textField(
                form,
                errors,
                'summary',
                'Summary',
                'One or two sentences on what was reported.',
                h,
              ),
              h.div(
                [h.Class('grid gap-6 sm:grid-cols-2')],
                [
                  selectField(
                    'centre',
                    'Operational centre',
                    form.centre,
                    CENTRES,
                    centre => centre,
                    h,
                  ),
                  selectField(
                    'channel',
                    'Channel',
                    form.channel,
                    CHANNELS,
                    humanise,
                    h,
                  ),
                ],
              ),
              h.div(
                [h.Class('flex flex-col gap-2')],
                [
                  h.label(
                    [h.Class(labelClassName), h.For(fieldId('receivedAt'))],
                    ['Received (UTC)'],
                  ),
                  h.input([
                    h.Id(fieldId('receivedAt')),
                    h.Type('datetime-local'),
                    h.Value(form.receivedAt),
                    h.Class(fieldClassName),
                    ...invalidAttributes(receivedError, 'receivedAt', h),
                    h.OnInput(value =>
                      Message.UpdatedEntryField({ field: 'receivedAt', value }),
                    ),
                  ]),
                  fieldError(receivedError, 'receivedAt', h),
                ],
              ),
              h.div(
                [h.Class('grid gap-6 sm:grid-cols-3')],
                [
                  selectField(
                    'scope',
                    'Scope',
                    form.scope,
                    SCOPES,
                    choice => choice,
                    h,
                  ),
                  selectField(
                    'risk',
                    'Risk',
                    form.risk,
                    RISKS,
                    choice => choice,
                    h,
                  ),
                  selectField(
                    'urgency',
                    'Urgency',
                    form.urgency,
                    URGENCIES,
                    choice => choice,
                    h,
                  ),
                ],
              ),
              signalsField(form, h),
              h.div(
                [h.Class('flex flex-col gap-2')],
                [
                  h.label(
                    [h.Class(labelClassName), h.For(fieldId('details'))],
                    ['Details (optional)'],
                  ),
                  h.textarea([
                    h.Id(fieldId('details')),
                    h.Rows(5),
                    h.Value(form.details),
                    h.Class(textAreaClassName),
                    ...invalidAttributes(detailsError, 'details', h),
                    h.OnInput(value =>
                      Message.UpdatedEntryField({ field: 'details', value }),
                    ),
                  ]),
                  fieldError(detailsError, 'details', h),
                ],
              ),
              h.div(
                [h.Class('grid gap-6 sm:grid-cols-2')],
                [
                  textField(
                    form,
                    errors,
                    'location',
                    'Location (optional)',
                    '',
                    h,
                  ),
                  textField(
                    form,
                    errors,
                    'reference',
                    'External reference (optional)',
                    '',
                    h,
                  ),
                ],
              ),
              EntrySubmission.match(form.submission, {
                Editing: () => h.empty,
                Submitting: () => h.empty,
                Failed: ({ failure }) =>
                  h.p(
                    [
                      h.Role('alert'),
                      h.Class('text-base font-medium text-msf-red'),
                    ],
                    [failureText(failure)],
                  ),
              }),
              h.div(
                [h.Class('flex flex-wrap items-center gap-6')],
                [
                  h.button(
                    [
                      h.Type('submit'),
                      h.Disabled(isSubmitting),
                      h.Class(primaryButtonClassName),
                    ],
                    [isSubmitting ? 'Saving…' : 'Save case'],
                  ),
                  h.button(
                    [
                      h.Type('button'),
                      h.Class(clsx('text-base', textButtonClassName)),
                      h.OnClick(Message.ClickedPage({ page: 'Desk' })),
                    ],
                    ['Back to cases'],
                  ),
                ],
              ),
            ],
          ),
          preview(model, h),
        ],
      ),
    ],
  )
}
