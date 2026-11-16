import { clsx } from 'clsx'
import { Array, Clock, Effect, Option, Schema, Stream } from 'effect'
import { Command, Submodel, Subscription, Update } from 'foldkit'
import { Html, HtmlBuilder } from 'foldkit/html'
import { defineMessageUnion } from 'foldkit/message'
import { modifyFields } from 'foldkit/struct'

import {
  IN_APP_TEXT,
  NotificationEntry,
  NotificationPage,
  isMessageKind,
  notificationLink,
} from '@case-desk/domain'

import { focusRing } from '../style'
import { withQuoroom } from './api'
import { actionButton } from './entryViews'
import { Failure, failureOf } from './failure'
import { zoneNote } from './rounds'
import { PageScope, isCurrentPage, pageScopeOf } from './scope'
import { alertText, failureAlert, loadingText, subPanel } from './ui'
import { LoadState } from './unit'
import { pollUnread } from './unreadPoll'
import { deadlineText } from './zoned'

// NOTE: The in-app notifications: what Quoroom told the account, the
// newest first, each with a link to the revision or screen it is about. The
// number not yet read is kept here too, because the navigation shows it on
// every screen; a poll refreshes it while signed in, slower while nothing changes and
// not at all while the tab is hidden. The
// lines are the generic words of D12 and D19 (`IN_APP_TEXT`): they never name
// a case title or hold report text (D17).

const PAGE_SIZE = 25
const MAX_MARK = 100

export const Model = Schema.Struct({
  generation: Schema.Int,
  reportId: Schema.String,
  load: LoadState,
  items: Schema.Array(NotificationEntry),
  maybeNext: Schema.Option(Schema.Int),
  unread: Schema.Int,
  zone: Schema.String,
  nowMs: Schema.Int,
  isLoadingMore: Schema.Boolean,
  isMarking: Schema.Boolean,
  maybeNotice: Schema.Option(Schema.String),
})
export type Model = typeof Model.Type

export const initialModel = Model.make({
  generation: 0,
  reportId: '',
  load: LoadState.Loading(),
  items: [],
  maybeNext: Option.none(),
  unread: 0,
  zone: 'UTC',
  nowMs: 0,
  isLoadingMore: false,
  isMarking: false,
  maybeNotice: Option.none(),
})

export const Message = defineMessageUnion({
  SucceededLoadNotifications: {
    scope: PageScope,
    page: NotificationPage,
    zone: Schema.String,
    nowMs: Schema.Int,
  },
  FailedLoadNotifications: { scope: PageScope, failure: Failure },
  ClickedRetryLoad: {},
  ClickedLoadMore: {},
  SucceededLoadMore: { scope: PageScope, page: NotificationPage },
  FailedLoadMore: { scope: PageScope, failure: Failure },
  ClickedMarkRead: { id: Schema.String },
  ClickedMarkAllRead: {},
  SucceededMarkRead: {
    scope: PageScope,
    ids: Schema.Array(Schema.String),
    unread: Schema.Int,
    nowMs: Schema.Int,
  },
  FailedMarkRead: { scope: PageScope, failure: Failure },
  PolledUnread: { unread: Schema.Int },
})
export type Message = typeof Message.Type

// COMMAND

export const LoadNotifications = Command.define('LoadNotifications', {
  args: { scope: PageScope },
  messages: [
    Message.SucceededLoadNotifications,
    Message.FailedLoadNotifications,
  ],
  execute: ({ scope }) =>
    Effect.gen(function* () {
      const page = yield* withQuoroom(client =>
        client.ListNotifications({ limit: PAGE_SIZE }),
      )
      const nowMs = yield* Clock.currentTimeMillis
      const zone = yield* Effect.sync(
        () => Intl.DateTimeFormat().resolvedOptions().timeZone,
      )
      return Message.SucceededLoadNotifications({ scope, page, zone, nowMs })
    }).pipe(
      Effect.catch(error =>
        Effect.succeed(
          Message.FailedLoadNotifications({
            scope,
            failure: failureOf(error),
          }),
        ),
      ),
    ),
})

export const LoadMoreNotifications = Command.define('LoadMoreNotifications', {
  args: { scope: PageScope, before: Schema.Int },
  messages: [Message.SucceededLoadMore, Message.FailedLoadMore],
  execute: ({ scope, before }) =>
    withQuoroom(client =>
      client.ListNotifications({ before, limit: PAGE_SIZE }),
    ).pipe(
      Effect.map(page => Message.SucceededLoadMore({ scope, page })),
      Effect.catch(error =>
        Effect.succeed(
          Message.FailedLoadMore({ scope, failure: failureOf(error) }),
        ),
      ),
    ),
})

export const MarkRead = Command.define('MarkRead', {
  args: { scope: PageScope, ids: Schema.Array(Schema.String) },
  messages: [Message.SucceededMarkRead, Message.FailedMarkRead],
  execute: ({ scope, ids }) =>
    Effect.gen(function* () {
      const { unread } = yield* withQuoroom(client =>
        client.MarkNotificationsRead({ ids }),
      )
      const nowMs = yield* Clock.currentTimeMillis
      return Message.SucceededMarkRead({ scope, ids, unread, nowMs })
    }).pipe(
      Effect.catch(error =>
        Effect.succeed(
          Message.FailedMarkRead({ scope, failure: failureOf(error) }),
        ),
      ),
    ),
})

// INIT

// NOTE: The unread count belongs to the signed-in account, not to the screen,
// so entering the screen again keeps it until the page answers.
export const enter = (model: Model): Update.Return<Model, Message> => {
  const fresh = modifyFields(initialModel, {
    generation: () => model.generation + 1,
    unread: () => model.unread,
  })
  return {
    model: fresh,
    commands: [LoadNotifications({ scope: pageScopeOf(fresh) })],
  }
}

export const cleared = (model: Model): Model =>
  modifyFields(initialModel, { generation: () => model.generation + 1 })

// UPDATE

const markedRead = (
  items: ReadonlyArray<typeof NotificationEntry.Type>,
  ids: ReadonlyArray<string>,
  nowMs: number,
): ReadonlyArray<typeof NotificationEntry.Type> =>
  Array.map(items, item =>
    ids.includes(item.id) && item.readAt === undefined
      ? { ...item, readAt: nowMs }
      : item,
  )

const updateCurrent = (model: Model, message: Message) =>
  Message.match<Update.Return<Model, Message>>(message, {
    SucceededLoadNotifications: ({ page, zone, nowMs }) => ({
      model: modifyFields(model, {
        load: () => LoadState.Loaded(),
        items: () => page.items,
        maybeNext: () => Option.fromNullishOr(page.next),
        unread: () => page.unread,
        zone: () => zone,
        nowMs: () => nowMs,
      }),
    }),
    FailedLoadNotifications: ({ failure }) => ({
      model: modifyFields(model, { load: () => LoadState.Failed({ failure }) }),
    }),
    ClickedRetryLoad: () => ({
      model: modifyFields(model, { load: () => LoadState.Loading() }),
      commands: [LoadNotifications({ scope: pageScopeOf(model) })],
    }),
    ClickedLoadMore: () =>
      Option.match(model.maybeNext, {
        onNone: () => ({ model }),
        onSome: before =>
          model.isLoadingMore
            ? { model }
            : {
                model: modifyFields(model, {
                  isLoadingMore: () => true,
                  maybeNotice: () => Option.none(),
                }),
                commands: [
                  LoadMoreNotifications({ scope: pageScopeOf(model), before }),
                ],
              },
      }),
    SucceededLoadMore: ({ page }) => ({
      model: modifyFields(model, {
        isLoadingMore: () => false,
        items: items => [...items, ...page.items],
        maybeNext: () => Option.fromNullishOr(page.next),
        unread: () => page.unread,
      }),
    }),
    FailedLoadMore: () => ({
      model: modifyFields(model, {
        isLoadingMore: () => false,
        maybeNotice: () =>
          Option.some('More notifications could not be loaded. Try again.'),
      }),
    }),
    ClickedMarkRead: ({ id }) =>
      model.isMarking
        ? { model }
        : {
            model: modifyFields(model, {
              isMarking: () => true,
              maybeNotice: () => Option.none(),
            }),
            commands: [MarkRead({ scope: pageScopeOf(model), ids: [id] })],
          },
    ClickedMarkAllRead: () => {
      const ids = Array.map(
        Array.take(
          Array.filter(model.items, item => item.readAt === undefined),
          MAX_MARK,
        ),
        item => item.id,
      )
      return model.isMarking || Array.isReadonlyArrayEmpty(ids)
        ? { model }
        : {
            model: modifyFields(model, {
              isMarking: () => true,
              maybeNotice: () => Option.none(),
            }),
            commands: [MarkRead({ scope: pageScopeOf(model), ids })],
          }
    },
    SucceededMarkRead: ({ ids, unread, nowMs }) => ({
      model: modifyFields(model, {
        isMarking: () => false,
        items: items => markedRead(items, ids, nowMs),
        unread: () => unread,
      }),
    }),
    FailedMarkRead: () => ({
      model: modifyFields(model, {
        isMarking: () => false,
        maybeNotice: () =>
          Option.some('The notification could not be marked as read. Try again.'),
      }),
    }),
    // NOTE: A poll answers for the account, not for a page, so it has no scope.
    PolledUnread: ({ unread }) => ({
      model: modifyFields(model, { unread: () => unread }),
    }),
  })

export const update = (
  model: Model,
  message: Message,
): Update.Return<Model, Message> =>
  'scope' in message && !isCurrentPage(model, message.scope)
    ? { model }
    : updateCurrent(model, message)

// SUBSCRIPTION

// NOTE: The count is asked for at once and then at a pace that slows while
// nothing changes and stops while the tab is hidden (`unreadPoll.ts`), for as
// long as the account is signed in (the parent turns this on and off). A poll
// that fails says nothing: the next one tries again.
export const subscriptions = Subscription.make<Model, Message>()(_entry => ({
  pollUnread: Subscription.persistentEntry(
    pollUnread(withQuoroom(client => client.GetUnreadCount()).pipe(
      Effect.map(({ unread }) => unread),
      Effect.option,
    )).pipe(Stream.map(unread => Message.PolledUnread({ unread }))),
  ),
}))

// VIEW

export const unreadLabel = (label: string, unread: number): string =>
  unread > 0 ? `${label} (${unread})` : label

const isUnread = (item: typeof NotificationEntry.Type): boolean =>
  item.readAt === undefined

const lineOf = (item: typeof NotificationEntry.Type): string =>
  isMessageKind(item.kind) ? IN_APP_TEXT[item.kind] : ''

const linkOf = (item: typeof NotificationEntry.Type): Option.Option<string> =>
  item.reportId !== undefined && isMessageKind(item.kind)
    ? Option.some(
        notificationLink(item.kind, item.reportId, item.revision ?? 1),
      )
    : Option.none()

const itemRow = (
  h: HtmlBuilder<Message>,
  model: Model,
  item: typeof NotificationEntry.Type,
): Html =>
  h.keyed('li')(
    item.id,
    [
      h.Class('flex flex-col gap-1 py-4'),
      h.DataAttribute('notification', item.id),
      h.DataAttribute('kind', item.kind),
      h.DataAttribute('unread', isUnread(item) ? 'true' : 'false'),
    ],
    [
      h.p(
        [
          h.Class(
            clsx(
              'text-lg text-msf-ink',
              isUnread(item) ? 'font-bold' : 'font-normal',
            ),
          ),
        ],
        [isUnread(item) ? `Unread. ${lineOf(item)}` : lineOf(item)],
      ),
      item.deadline === undefined
        ? h.empty
        : h.p(
            [h.Class('text-base text-msf-ink')],
            [
              `Due ${deadlineText(item.deadline.at, model.zone)}${zoneNote(item.deadline.timeZone, model.zone)}.`,
            ],
          ),
      h.p(
        [h.Class('text-sm text-msf-grey')],
        [`Sent ${deadlineText(item.at, model.zone)}`],
      ),
      h.div(
        [h.Class('mt-2 flex flex-wrap items-center gap-3')],
        [
          Option.match(linkOf(item), {
            onNone: () => h.empty,
            onSome: href =>
              h.a(
                [
                  h.Href(href),
                  h.Class(
                    clsx(
                      'inline-flex min-h-11 items-center border border-msf-ink px-4 text-base font-medium text-msf-ink hover:bg-msf-mist',
                      focusRing,
                    ),
                  ),
                  h.AriaLabel(`Open: ${lineOf(item)}`),
                ],
                ['Open'],
              ),
          }),
          isUnread(item)
            ? actionButton(
                h,
                'Mark as read',
                `Mark as read: ${lineOf(item)}`,
                Message.ClickedMarkRead({ id: item.id }),
                model.isMarking,
              )
            : h.empty,
        ],
      ),
    ],
  )

const shell = (
  h: HtmlBuilder<Message>,
  children: ReadonlyArray<Html>,
): Html =>
  h.section(
    [
      h.AriaLabel('Notifications'),
      h.Class('flex flex-col gap-6 border-t-2 border-msf-ink pt-5'),
    ],
    [
      h.h2([h.Class('text-2xl font-black tracking-tight')], ['Notifications']),
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
        Array.match(model.items, {
          onEmpty: () =>
            h.p(
              [h.Class('text-lg text-msf-grey')],
              [
                'Nothing yet. Requests, reminders and decisions about your reports appear here.',
              ],
            ),
          onNonEmpty: rows =>
            subPanel(h, 'Newest first', [
              h.p(
                [h.Id('unread-count'), h.Class('text-base text-msf-ink')],
                [
                  model.unread === 0
                    ? 'You have read everything.'
                    : `${model.unread} not read yet.`,
                ],
              ),
              model.unread === 0
                ? h.empty
                : actionButton(
                    h,
                    'Mark all as read',
                    'Mark all notifications as read',
                    Message.ClickedMarkAllRead(),
                    model.isMarking,
                  ),
              h.ul(
                [
                  h.AriaLabel('Notifications'),
                  h.Class(
                    'flex flex-col divide-y divide-msf-line border-y border-msf-line',
                  ),
                ],
                Array.map(rows, item => itemRow(h, model, item)),
              ),
            ]),
        }),
        Option.match(model.maybeNotice, {
          onNone: () => h.empty,
          onSome: notice => alertText(h, notice),
        }),
        Option.isSome(model.maybeNext)
          ? actionButton(
              h,
              model.isLoadingMore ? 'Loading…' : 'Show more',
              'Show more notifications',
              Message.ClickedLoadMore(),
              model.isLoadingMore,
            )
          : h.empty,
      ]),
  }),
)
