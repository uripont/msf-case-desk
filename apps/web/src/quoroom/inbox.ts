import { clsx } from 'clsx'
import { Array, Clock, Effect, Option, Schema } from 'effect'
import { Command, Submodel, Update } from 'foldkit'
import { Html, HtmlBuilder } from 'foldkit/html'
import { defineMessageUnion } from 'foldkit/message'
import { modifyFields } from 'foldkit/struct'

import { InboxItem, InboxPage } from '@case-desk/domain'

import { AppRoute, pathOf } from '../route'
import { focusRing } from '../style'
import { withQuoroom } from './api'
import { actionButton } from './entryViews'
import { Failure, failureOf } from './failure'
import { decisionText, zoneNote } from './rounds'
import { PageScope, isCurrentPage, pageScopeOf } from './scope'
import { alertText, failureAlert, loadingText, subPanel } from './ui'
import { LoadState } from './unit'
import { countdownText, deadlineText } from './zoned'

// NOTE: The reviewer's inbox: the rounds the account takes part in,
// each with its deadline in the reviewer's own time zone, what they sent, and
// whether the round is decided or replaced. It shows the reference of the case
// file, never its title. Rounds waiting for a review come first.

const PAGE_SIZE = 25

export const Model = Schema.Struct({
  origin: Schema.String,
  reportId: Schema.String,
  generation: Schema.Int,
  load: LoadState,
  items: Schema.Array(InboxItem),
  maybeNext: Schema.Option(Schema.Int),
  zone: Schema.String,
  nowMs: Schema.Int,
  isLoadingMore: Schema.Boolean,
  maybeNotice: Schema.Option(Schema.String),
})
export type Model = typeof Model.Type

export const initialModel = Model.make({
  origin: '',
  reportId: '',
  generation: 0,
  load: LoadState.Loading(),
  items: [],
  maybeNext: Option.none(),
  zone: 'UTC',
  nowMs: 0,
  isLoadingMore: false,
  maybeNotice: Option.none(),
})

export const Message = defineMessageUnion({
  SucceededLoadInbox: {
    scope: PageScope,
    page: InboxPage,
    zone: Schema.String,
    nowMs: Schema.Int,
  },
  FailedLoadInbox: { scope: PageScope, failure: Failure },
  ClickedRetryLoad: {},
  ClickedLoadMore: {},
  SucceededLoadMore: { scope: PageScope, page: InboxPage },
  FailedLoadMore: { scope: PageScope, failure: Failure },
})
export type Message = typeof Message.Type

// COMMAND

export const LoadInbox = Command.define('LoadInbox', {
  args: { scope: PageScope },
  messages: [Message.SucceededLoadInbox, Message.FailedLoadInbox],
  execute: ({ scope }) =>
    Effect.gen(function* () {
      const page = yield* withQuoroom(client =>
        client.ListInbox({ offset: 0, limit: PAGE_SIZE }),
      )
      const nowMs = yield* Clock.currentTimeMillis
      const zone = yield* Effect.sync(
        () => Intl.DateTimeFormat().resolvedOptions().timeZone,
      )
      return Message.SucceededLoadInbox({ scope, page, zone, nowMs })
    }).pipe(
      Effect.catch(error =>
        Effect.succeed(
          Message.FailedLoadInbox({ scope, failure: failureOf(error) }),
        ),
      ),
    ),
})

export const LoadMoreInbox = Command.define('LoadMoreInbox', {
  args: { scope: PageScope, offset: Schema.Int },
  messages: [Message.SucceededLoadMore, Message.FailedLoadMore],
  execute: ({ scope, offset }) =>
    withQuoroom(client =>
      client.ListInbox({ offset, limit: PAGE_SIZE }),
    ).pipe(
      Effect.map(page => Message.SucceededLoadMore({ scope, page })),
      Effect.catch(error =>
        Effect.succeed(
          Message.FailedLoadMore({ scope, failure: failureOf(error) }),
        ),
      ),
    ),
})

// INIT

export const enter = (
  origin: string,
  generation: number,
): Update.Return<Model, Message> => {
  const fresh = modifyFields(initialModel, {
    origin: () => origin,
    generation: () => generation,
  })
  return { model: fresh, commands: [LoadInbox({ scope: pageScopeOf(fresh) })] }
}

export const cleared = (model: Model): Model =>
  modifyFields(initialModel, { generation: () => model.generation + 1 })

// UPDATE

const updateCurrent = (model: Model, message: Message) =>
  Message.match<Update.Return<Model, Message>>(message, {
    SucceededLoadInbox: ({ page, zone, nowMs }) => ({
      model: modifyFields(model, {
        load: () => LoadState.Loaded(),
        items: () => page.items,
        maybeNext: () => Option.fromNullishOr(page.next),
        zone: () => zone,
        nowMs: () => nowMs,
      }),
    }),
    FailedLoadInbox: ({ failure }) => ({
      model: modifyFields(model, { load: () => LoadState.Failed({ failure }) }),
    }),
    ClickedRetryLoad: () => ({
      model: modifyFields(model, { load: () => LoadState.Loading() }),
      commands: [LoadInbox({ scope: pageScopeOf(model) })],
    }),
    ClickedLoadMore: () =>
      Option.match(model.maybeNext, {
        onNone: () => ({ model }),
        onSome: offset =>
          model.isLoadingMore
            ? { model }
            : {
                model: modifyFields(model, {
                  isLoadingMore: () => true,
                  maybeNotice: () => Option.none(),
                }),
                commands: [
                  LoadMoreInbox({ scope: pageScopeOf(model), offset }),
                ],
              },
      }),
    SucceededLoadMore: ({ page }) => ({
      model: modifyFields(model, {
        isLoadingMore: () => false,
        items: items => [...items, ...page.items],
        maybeNext: () => Option.fromNullishOr(page.next),
      }),
    }),
    FailedLoadMore: () => ({
      model: modifyFields(model, {
        isLoadingMore: () => false,
        maybeNotice: () =>
          Option.some('More rounds could not be loaded. Try again.'),
      }),
    }),
  })

export const update = (
  model: Model,
  message: Message,
): Update.Return<Model, Message> =>
  'scope' in message && !isCurrentPage(model, message.scope)
    ? { model }
    : updateCurrent(model, message)

// VIEW

export const isWaiting = (item: typeof InboxItem.Type): boolean =>
  item.status === 'open' && item.myDecision === undefined

const statusLine = (item: typeof InboxItem.Type): string => {
  if (item.status === 'superseded') {
    return 'Replaced by a newer revision. This one is closed.'
  }
  if (item.status === 'decided') {
    return item.myDecision === undefined
      ? 'Decided. No more reviews are accepted.'
      : `Decided. You sent: ${decisionText(item.myDecision)}.`
  }
  return item.myDecision === undefined
    ? 'Waiting for your review.'
    : `You sent: ${decisionText(item.myDecision)}. You can still send another review.`
}

const itemRow = (
  h: HtmlBuilder<Message>,
  model: Model,
  item: typeof InboxItem.Type,
): Html =>
  h.keyed('li')(
    `${item.reportId}-${item.revision}`,
    [
      h.Class('flex flex-col gap-1 py-4'),
      h.DataAttribute('inbox-item', `${item.reportId}/${item.revision}`),
      h.DataAttribute('status', item.status),
      h.DataAttribute('waiting', isWaiting(item) ? 'true' : 'false'),
    ],
    [
      h.p(
        [h.Class('text-xl font-bold text-msf-black')],
        [`${item.label} of ${item.caseReference}`],
      ),
      h.p([h.Class('text-base text-msf-grey')], [item.reportName]),
      h.p([h.Class('text-lg text-msf-ink')], [statusLine(item)]),
      h.p(
        [h.Class('text-base text-msf-ink')],
        [
          `Due ${deadlineText(item.deadline.at, model.zone)}${zoneNote(item.deadline.timeZone, model.zone)}`,
          item.status === 'open'
            ? `. ${countdownText(item.deadline.at, model.nowMs)}.`
            : '.',
        ],
      ),
      item.hasPending
        ? h.p(
            [h.Class('text-base font-medium text-msf-ink')],
            ['You have comments that are not sent yet.'],
          )
        : h.empty,
      h.a(
        [
          h.Href(
            pathOf(
              AppRoute.Revision({
                reportId: item.reportId,
                revision: item.revision,
              }),
            ),
          ),
          h.Class(
            clsx(
              'mt-2 inline-flex min-h-11 items-center self-start border border-msf-ink px-4 text-base font-medium text-msf-ink hover:bg-msf-mist',
              focusRing,
            ),
          ),
          h.AriaLabel(`Read ${item.label} of ${item.caseReference}`),
        ],
        [isWaiting(item) ? 'Read and review' : 'Read'],
      ),
    ],
  )

const listPanel = (
  h: HtmlBuilder<Message>,
  model: Model,
  heading: string,
  items: ReadonlyArray<typeof InboxItem.Type>,
): Html =>
  Array.match(items, {
    onEmpty: () => h.empty,
    onNonEmpty: rows =>
      subPanel(h, heading, [
        h.ul(
          [
            h.AriaLabel(heading),
            h.Class(
              'flex flex-col divide-y divide-msf-line border-y border-msf-line',
            ),
          ],
          Array.map(rows, item => itemRow(h, model, item)),
        ),
      ]),
  })

const shell = (
  h: HtmlBuilder<Message>,
  children: ReadonlyArray<Html>,
): Html =>
  h.section(
    [
      h.AriaLabel('Inbox'),
      h.Class('flex flex-col gap-6 border-t-2 border-msf-ink pt-5'),
    ],
    [
      h.h2([h.Class('text-2xl font-black tracking-tight')], ['Inbox']),
      ...children,
    ],
  )

export const view = Submodel.defineView<Model, Message>((model, h) =>
  LoadState.match(model.load, {
    Loading: () => shell(h, [loadingText(h, 'Loading.')]),
    Failed: ({ failure }) =>
      shell(h, [
        failureAlert(h, failure),
        actionButton(h, 'Try again', 'Try again', Message.ClickedRetryLoad()),
      ]),
    Loaded: () =>
      shell(h, [
        Array.isReadonlyArrayEmpty(model.items)
          ? h.p(
              [h.Class('text-lg text-msf-grey')],
              ['Nothing is waiting for you. Rounds you are asked to review appear here.'],
            )
          : h.empty,
        listPanel(
          h,
          model,
          'Waiting for your review',
          Array.filter(model.items, isWaiting),
        ),
        listPanel(
          h,
          model,
          'Other rounds',
          Array.filter(model.items, item => !isWaiting(item)),
        ),
        Option.match(model.maybeNotice, {
          onNone: () => h.empty,
          onSome: notice => alertText(h, notice),
        }),
        Option.isSome(model.maybeNext)
          ? actionButton(
              h,
              model.isLoadingMore ? 'Loading…' : 'Show more',
              'Show more rounds',
              Message.ClickedLoadMore(),
              model.isLoadingMore,
            )
          : h.empty,
      ]),
  }),
)
