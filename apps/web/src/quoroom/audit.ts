import { clsx } from 'clsx'
import { Array, Effect, Option, Record, Schema } from 'effect'
import { Command, Submodel, Update } from 'foldkit'
import { Html, HtmlBuilder } from 'foldkit/html'
import { defineMessageUnion } from 'foldkit/message'
import { modifyFields } from 'foldkit/struct'

import { AuditEvent, AuditKind } from '@quoroom/domain'

import { AppRoute, pathOf } from '../route'
import { focusRing } from '../style'
import { withQuoroom } from './api'
import { momentText, momentWithZone } from './draftText'
import { actionButton } from './entryViews'
import { Failure, failureOf, failureText } from './failure'
import { PageScope, isCurrentPage, pageScopeOf } from './scope'
import { alertText, loadingText, selectField } from './ui'
import { LoadState } from './unit'

// NOTE: The audit log of a report, for its authors: newest first, a page at a
// time, filtered by the kind of fact. Each event shows its time in the
// viewer's own time zone. The log holds small metadata, never report text.

const PAGE_SIZE = 20

export const KINDS: ReadonlyArray<Readonly<{ value: string; label: string }>> = [
  { value: 'all', label: 'Everything' },
  { value: 'report', label: 'The report' },
  { value: 'draft', label: 'Drafts' },
  { value: 'redaction', label: 'Redaction' },
  { value: 'revision', label: 'Revisions' },
  { value: 'review', label: 'Reviews' },
  { value: 'round', label: 'Rounds' },
]

const ACTION_TEXT: Readonly<Record<string, string>> = {
  'report.created': 'The report was created',
  'report.co_author_added': 'A co-author was added',
  'report.conclusion_started': 'The conclusion was started',
  'report.archived': 'The report was archived',
  'draft.shared': 'A draft was shared',
  'redaction.confirmed': 'The redacted version was confirmed',
  'revision.published': 'A revision was published for review',
  'review.sent': 'A review was sent',
  'round.deadline_extended': 'The deadline was extended',
  'round.reviewer_removed': 'A reviewer was removed from the round',
  'round.decided': 'The round was decided',
}

export const actionText = (action: string): string =>
  ACTION_TEXT[action] ?? action.replaceAll('.', ' ').replaceAll('_', ' ')

export const Model = Schema.Struct({
  origin: Schema.String,
  reportId: Schema.String,
  generation: Schema.Int,
  load: LoadState,
  events: Schema.Array(AuditEvent),
  maybeNext: Schema.Option(Schema.String),
  kind: Schema.String,
  isLoadingMore: Schema.Boolean,
  maybeNotice: Schema.Option(Schema.String),
})
export type Model = typeof Model.Type

export const initialModel = Model.make({
  origin: '',
  reportId: '',
  generation: 0,
  load: LoadState.Loading(),
  events: [],
  maybeNext: Option.none(),
  kind: 'all',
  isLoadingMore: false,
  maybeNotice: Option.none(),
})

export const Message = defineMessageUnion({
  SucceededLoadAudit: {
    scope: PageScope,
    events: Schema.Array(AuditEvent),
    maybeNext: Schema.Option(Schema.String),
    // NOTE: the filter the page was asked for: an answer for another filter
    // than the one chosen now is dropped.
    kind: Schema.String,
    isMore: Schema.Boolean,
  },
  FailedLoadAudit: { scope: PageScope, failure: Failure, isMore: Schema.Boolean },
  ClickedRetryLoad: {},
  ChoseKind: { value: Schema.String },
  ClickedLoadOlder: {},
})
export type Message = typeof Message.Type

export const LoadAudit = Command.define('LoadAudit', {
  args: {
    scope: PageScope,
    maybeBefore: Schema.Option(Schema.String),
    // NOTE: `all`, or a kind the server filters by before it cuts the page.
    kind: Schema.String,
    isMore: Schema.Boolean,
  },
  messages: [Message.SucceededLoadAudit, Message.FailedLoadAudit],
  execute: ({ scope, scope: { reportId }, maybeBefore, kind, isMore }) =>
    withQuoroom(client =>
      client.ListAuditEvents({
        subject: { kind: 'report', reportId },
        limit: PAGE_SIZE,
        ...(Schema.is(AuditKind)(kind) ? { kind } : {}),
        ...Option.match(maybeBefore, {
          onNone: () => ({}),
          onSome: before => ({ before }),
        }),
      }),
    ).pipe(
      Effect.map(page =>
        Message.SucceededLoadAudit({
          scope,
          events: page.events,
          maybeNext: Option.fromNullishOr(page.next),
          kind,
          isMore,
        }),
      ),
      Effect.catch(error =>
        Effect.succeed(
          Message.FailedLoadAudit({ scope, failure: failureOf(error), isMore }),
        ),
      ),
    ),
})

export const enter = (
  origin: string,
  reportId: string,
  generation: number,
): Update.Return<Model, Message> => {
  const fresh = modifyFields(initialModel, {
    origin: () => origin,
    reportId: () => reportId,
    generation: () => generation,
  })
  return {
    model: fresh,
    commands: [
      LoadAudit({
        scope: pageScopeOf(fresh),
        maybeBefore: Option.none(),
        kind: 'all',
        isMore: false,
      }),
    ],
  }
}

export const cleared = (model: Model): Model =>
  modifyFields(initialModel, { generation: () => model.generation + 1 })

const updateCurrent = (
  model: Model,
  message: Message,
): Update.Return<Model, Message> =>
  Message.match<Update.Return<Model, Message>>(message, {
    SucceededLoadAudit: ({ events, maybeNext, kind, isMore }) =>
      kind !== model.kind
        ? { model }
        : {
            model: modifyFields(model, {
              load: () => LoadState.Loaded(),
              isLoadingMore: () => false,
              events: existing => (isMore ? [...existing, ...events] : events),
              maybeNext: () => maybeNext,
              maybeNotice: () => Option.none(),
            }),
          },
    FailedLoadAudit: ({ failure, isMore }) => ({
      model: isMore
        ? modifyFields(model, {
            isLoadingMore: () => false,
            maybeNotice: () => Option.some(failureText(failure)),
          })
        : modifyFields(model, { load: () => LoadState.Failed({ failure }) }),
    }),
    ClickedRetryLoad: () => ({
      model: modifyFields(model, { load: () => LoadState.Loading() }),
      commands: [
        LoadAudit({
          scope: pageScopeOf(model),
          maybeBefore: Option.none(),
          kind: model.kind,
          isMore: false,
        }),
      ],
    }),
    // NOTE: the filter is the server's: the list starts again from the newest
    // event of that kind, a page at a time.
    ChoseKind: ({ value }) => ({
      model: modifyFields(model, {
        kind: () => value,
        isLoadingMore: () => true,
        maybeNotice: () => Option.none(),
      }),
      commands: [
        LoadAudit({
          scope: pageScopeOf(model),
          maybeBefore: Option.none(),
          kind: value,
          isMore: false,
        }),
      ],
    }),
    ClickedLoadOlder: () =>
      model.isLoadingMore
        ? { model }
        : {
            model: modifyFields(model, { isLoadingMore: () => true }),
            commands: [
              LoadAudit({
                scope: pageScopeOf(model),
                maybeBefore: model.maybeNext,
                kind: model.kind,
                isMore: true,
              }),
            ],
          },
  })

export const update = (
  model: Model,
  message: Message,
): Update.Return<Model, Message> =>
  'scope' in message && !isCurrentPage(model, message.scope)
    ? { model }
    : updateCurrent(model, message)

// VIEW

const metaText = (meta: typeof AuditEvent.Type['meta']): string =>
  Array.join(
    Array.map(Record.toEntries(meta), ([key, value]) =>
      key === 'deadline' && typeof value === 'number'
        ? `deadline ${momentText(value)}`
        : `${key.replaceAll('_', ' ')} ${String(value)}`,
    ),
    ', ',
  )

const eventRow = (
  h: HtmlBuilder<Message>,
  event: typeof AuditEvent.Type,
): Html =>
  h.keyed('li')(
    event.id,
    [
      h.Class('flex flex-col gap-1 py-3'),
      h.DataAttribute('audit', event.action),
      h.DataAttribute('at', String(event.at)),
    ],
    [
      h.p([h.Class('text-lg font-medium text-brand-ink')], [actionText(event.action)]),
      h.p(
        [h.Class('text-base text-brand-grey')],
        [
          [
            momentWithZone(event.at),
            event.actor === undefined ? '' : `, ${event.actor.name}`,
            event.draft === undefined ? '' : `, Draft ${event.draft}`,
            event.revision === undefined ? '' : `, Revision ${event.revision}`,
          ].join(''),
        ],
      ),
      Record.isEmptyRecord(event.meta)
        ? h.empty
        : h.p([h.Class('text-sm text-brand-grey')], [metaText(event.meta)]),
    ],
  )

const shell = (
  h: HtmlBuilder<Message>,
  reportId: string,
  children: ReadonlyArray<Html>,
): Html =>
  h.section(
    [h.AriaLabel('Audit log'), h.Class('flex max-w-3xl flex-col gap-6 pt-10 md:pt-14')],
    [
      h.div(
        [h.Class('flex flex-wrap gap-4')],
        [
          h.a(
            [
              h.Href(pathOf(AppRoute.Report({ reportId }))),
              h.Class(clsx('text-base text-brand-ink underline', focusRing)),
            ],
            ['Back to the report'],
          ),
          h.a(
            [
              h.Href(pathOf(AppRoute.Grid({ reportId }))),
              h.Class(clsx('text-base text-brand-ink underline', focusRing)),
            ],
            ['Status grid'],
          ),
        ],
      ),
      h.h1(
        [
          h.Id('page-heading'),
          h.Class('text-balance text-4xl font-black tracking-[-0.025em] text-brand-ink'),
        ],
        ['Audit log'],
      ),
      ...children,
    ],
  )

export const view = Submodel.defineView<Model, Message>((model, h) =>
  LoadState.match(model.load, {
    Loading: () => shell(h, model.reportId, [loadingText(h, 'Loading.')]),
    Failed: ({ failure }) =>
      shell(h, model.reportId, [
        alertText(h, failureText(failure)),
        actionButton(h, 'Try again', 'Try again', Message.ClickedRetryLoad()),
      ]),
    Loaded: () => {
      const shown = model.events
      return shell(h, model.reportId, [
        h.p(
          [h.Class('text-base text-brand-grey')],
          ['Newest first. Every time is shown in your own time zone. The log holds facts, never report text.'],
        ),
        selectField(h, 'audit-kind', 'Show', model.kind, KINDS, value =>
          Message.ChoseKind({ value }),
        ),
        Option.match(model.maybeNotice, {
          onNone: () => h.empty,
          onSome: notice => alertText(h, notice),
        }),
        Array.match(shown, {
          onEmpty: () =>
            h.p(
              [h.Class('text-lg text-brand-grey')],
              [
                'Nothing of this kind has happened.',
              ],
            ),
          onNonEmpty: rows =>
            h.ul(
              [
                h.AriaLabel('Audit events'),
                h.Class('flex flex-col divide-y divide-brand-line border-y border-brand-line'),
              ],
              Array.map(rows, row => eventRow(h, row)),
            ),
        }),
        Option.isSome(model.maybeNext)
          ? actionButton(
              h,
              model.isLoadingMore ? 'Loading.' : 'Load older events',
              'Load older events',
              Message.ClickedLoadOlder(),
              model.isLoadingMore,
            )
          : h.empty,
      ])
    },
  }),
)
