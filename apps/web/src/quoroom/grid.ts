import { clsx } from 'clsx'
import { Array, Clock, Effect, Option, Schema } from 'effect'
import { Command, Submodel, Update } from 'foldkit'
import { Html, HtmlBuilder } from 'foldkit/html'
import { defineMessageUnion } from 'foldkit/message'
import { modifyFields } from 'foldkit/struct'

import {
  GridView,
  ReportDetail,
  RoundView,
  Template,
  deadlineTooFar,
} from '@quoroom/domain'

import { AppRoute, pathOf } from '../route'
import { fieldClassName, focusRing, labelClassName } from '../style'
import { withQuoroom } from './api'
import { momentText } from './draftText'
import { actionButton } from './entryViews'
import { Failure, failureOf, failureText } from './failure'
import { removalOf, roleLines } from './roundActions'
import { decisionText } from './rounds'
import { PageScope, isCurrentPage, pageScopeOf } from './scope'
import { alertText, loadingText, panel, selectField, statusText } from './ui'
import { LoadState } from './unit'
import { dateTextIn, deadlineText, zoneChoices, zonedTimeToEpoch } from './zoned'

// NOTE: The status grid for authors (pipeline step 10) and the actions on an
// open round: extend its deadline, remove a reviewer after reading what that
// does to the approval rule. Every fact shows its time in the viewer's own
// time zone; a fact that is not known is not shown as a time. The tables
// scroll sideways inside their own box, never the page.

type Grid = typeof GridView.Type
type RevisionRow = Grid['grid']['revisions'][number]
type RevisionCell = RevisionRow['cells'][number]

export const Model = Schema.Struct({
  origin: Schema.String,
  reportId: Schema.String,
  generation: Schema.Int,
  load: LoadState,
  maybeDetail: Schema.Option(ReportDetail),
  maybeTemplate: Schema.Option(Template),
  maybeView: Schema.Option(GridView),
  maybeRound: Schema.Option(RoundView),
  extendDate: Schema.String,
  extendTime: Schema.String,
  extendZone: Schema.String,
  // NOTE: the time the grid was loaded; the bound on a new deadline is
  // checked against it (the server checks against its own clock).
  nowMs: Schema.Int,
  maybeRemoving: Schema.Option(Schema.String),
  isSending: Schema.Boolean,
  maybeNotice: Schema.Option(Schema.String),
  maybeDone: Schema.Option(Schema.String),
})
export type Model = typeof Model.Type

export const initialModel = Model.make({
  origin: '',
  reportId: '',
  generation: 0,
  load: LoadState.Loading(),
  maybeDetail: Option.none(),
  maybeTemplate: Option.none(),
  maybeView: Option.none(),
  maybeRound: Option.none(),
  extendDate: '',
  extendTime: '18:00',
  extendZone: '',
  nowMs: 0,
  maybeRemoving: Option.none(),
  isSending: false,
  maybeNotice: Option.none(),
  maybeDone: Option.none(),
})

export const LoadedGrid = Schema.Struct({
  detail: ReportDetail,
  template: Template,
  view: GridView,
  maybeRound: Schema.Option(RoundView),
  nowMs: Schema.Int,
})
export type LoadedGrid = typeof LoadedGrid.Type

export const Message = defineMessageUnion({
  SucceededLoadGrid: { scope: PageScope, loaded: LoadedGrid },
  FailedLoadGrid: { scope: PageScope, failure: Failure },
  ClickedRetryLoad: {},
  TypedExtendDate: { value: Schema.String },
  TypedExtendTime: { value: Schema.String },
  ChoseExtendZone: { value: Schema.String },
  SubmittedExtend: {},
  SucceededExtend: { scope: PageScope },
  FailedExtend: { scope: PageScope, failure: Failure },
  ClickedRemove: { accountId: Schema.String },
  CancelledRemove: {},
  ConfirmedRemove: {},
  SucceededRemove: { scope: PageScope },
  FailedRemove: { scope: PageScope, failure: Failure },
})
export type Message = typeof Message.Type

// COMMAND

export const LoadGrid = Command.define('LoadGrid', {
  args: { scope: PageScope },
  messages: [Message.SucceededLoadGrid, Message.FailedLoadGrid],
  execute: ({ scope, scope: { reportId } }) =>
    withQuoroom(client =>
      Effect.gen(function* () {
        const detail = yield* client.GetReport({ reportId })
        const version = yield* client.GetTemplateVersion({
          templateId: detail.summary.templateId,
          version: detail.summary.templateVersion,
          reportId,
        })
        const view = yield* client.GetGrid({ reportId })
        const open = Array.findLast(
          view.grid.revisions,
          row => row.status === 'open',
        )
        const maybeRound = yield* Option.match(open, {
          onNone: () => Effect.succeed(Option.none<RoundView>()),
          onSome: row =>
            client
              .GetRound({ reportId, revision: row.revision })
              .pipe(Effect.map(Option.some)),
        })
        const nowMs = yield* Clock.currentTimeMillis
        return { detail, template: version.template, view, maybeRound, nowMs }
      }),
    ).pipe(
      Effect.map(loaded => Message.SucceededLoadGrid({ scope, loaded })),
      Effect.catch(error =>
        Effect.succeed(
          Message.FailedLoadGrid({ scope, failure: failureOf(error) }),
        ),
      ),
    ),
})

export const ExtendRoundDeadline = Command.define('ExtendRoundDeadline', {
  args: {
    scope: PageScope,
    revision: Schema.Int,
    at: Schema.Number,
    timeZone: Schema.String,
  },
  messages: [Message.SucceededExtend, Message.FailedExtend],
  execute: ({ scope, scope: { reportId }, revision, at, timeZone }) =>
    withQuoroom(client =>
      client.ExtendDeadline({ reportId, revision, deadline: { at, timeZone } }),
    ).pipe(
      Effect.map(() => Message.SucceededExtend({ scope })),
      Effect.catch(error =>
        Effect.succeed(
          Message.FailedExtend({ scope, failure: failureOf(error) }),
        ),
      ),
    ),
})

export const RemoveRoundReviewer = Command.define('RemoveRoundReviewer', {
  args: { scope: PageScope, revision: Schema.Int, accountId: Schema.String },
  messages: [Message.SucceededRemove, Message.FailedRemove],
  execute: ({ scope, scope: { reportId }, revision, accountId }) =>
    withQuoroom(client =>
      client.RemoveReviewer({ reportId, revision, accountId }),
    ).pipe(
      Effect.map(() => Message.SucceededRemove({ scope })),
      Effect.catch(error =>
        Effect.succeed(
          Message.FailedRemove({ scope, failure: failureOf(error) }),
        ),
      ),
    ),
})

// INIT

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
    commands: [LoadGrid({ scope: pageScopeOf(fresh) })],
  }
}

export const cleared = (model: Model): Model =>
  modifyFields(initialModel, { generation: () => model.generation + 1 })

// QUERIES

export const mayChangeRound = (model: Model): boolean =>
  Option.exists(model.maybeDetail, detail =>
    Array.contains(detail.permissions, 'publish'),
  )

const DAY_MS = 86_400_000

// UPDATE

const reload = (model: Model, done: string): Update.Return<Model, Message> => ({
  model: modifyFields(model, {
    isSending: () => false,
    maybeRemoving: () => Option.none(),
    maybeNotice: () => Option.none(),
    maybeDone: () => Option.some(done),
  }),
  commands: [LoadGrid({ scope: pageScopeOf(model) })],
})

const failedWith = (model: Model, failure: Failure): Model =>
  modifyFields(model, {
    isSending: () => false,
    maybeDone: () => Option.none(),
    maybeNotice: () => Option.some(failureText(failure)),
  })

const updateCurrent = (
  model: Model,
  message: Message,
): Update.Return<Model, Message> =>
  Message.match<Update.Return<Model, Message>>(message, {
    SucceededLoadGrid: ({ loaded }) => {
      const zone = Option.match(loaded.maybeRound, {
        onNone: () => 'UTC',
        onSome: round => round.deadline.timeZone,
      })
      const date = Option.match(loaded.maybeRound, {
        onNone: () => '',
        onSome: round =>
          dateTextIn(round.deadline.at + 7 * DAY_MS, round.deadline.timeZone),
      })
      return {
        model: modifyFields(model, {
          load: () => LoadState.Loaded(),
          maybeDetail: () => Option.some(loaded.detail),
          maybeTemplate: () => Option.some(loaded.template),
          maybeView: () => Option.some(loaded.view),
          maybeRound: () => loaded.maybeRound,
          nowMs: () => loaded.nowMs,
          extendZone: current => (current === '' ? zone : current),
          extendDate: current => (current === '' ? date : current),
        }),
      }
    },
    FailedLoadGrid: ({ failure }) => ({
      model: modifyFields(model, { load: () => LoadState.Failed({ failure }) }),
    }),
    ClickedRetryLoad: () => ({
      model: modifyFields(model, { load: () => LoadState.Loading() }),
      commands: [LoadGrid({ scope: pageScopeOf(model) })],
    }),
    TypedExtendDate: ({ value }) => ({
      model: modifyFields(model, { extendDate: () => value }),
    }),
    TypedExtendTime: ({ value }) => ({
      model: modifyFields(model, { extendTime: () => value }),
    }),
    ChoseExtendZone: ({ value }) => ({
      model: modifyFields(model, { extendZone: () => value }),
    }),
    SubmittedExtend: () =>
      Option.match(model.maybeRound, {
        onNone: () => ({ model }),
        onSome: round =>
          Option.match(
            zonedTimeToEpoch(model.extendDate, model.extendTime, model.extendZone),
            {
              onNone: () => ({
                model: modifyFields(model, {
                  maybeDone: () => Option.none(),
                  maybeNotice: () =>
                    Option.some('Enter a real date, a time and a time zone.'),
                }),
              }),
              onSome: at =>
                deadlineTooFar(at, model.nowMs)
                  ? {
                      model: modifyFields(model, {
                        maybeDone: () => Option.none(),
                        maybeNotice: () =>
                          Option.some('The deadline can be at most one year ahead.'),
                      }),
                    }
                  : at <= round.deadline.at
                  ? {
                      model: modifyFields(model, {
                        maybeDone: () => Option.none(),
                        maybeNotice: () =>
                          Option.some(
                            'The new deadline must be later than the current one.',
                          ),
                      }),
                    }
                  : model.isSending
                    ? { model }
                    : {
                        model: modifyFields(model, {
                          isSending: () => true,
                          maybeNotice: () => Option.none(),
                          maybeDone: () => Option.none(),
                        }),
                        commands: [
                          ExtendRoundDeadline({
                            scope: pageScopeOf(model),
                            revision: round.revision,
                            at,
                            timeZone: model.extendZone,
                          }),
                        ],
                      },
            },
          ),
      }),
    SucceededExtend: () =>
      reload(
        modifyFields(model, { extendDate: () => '' }),
        'The deadline was extended. The reviewers are told.',
      ),
    FailedExtend: ({ failure }) => ({ model: failedWith(model, failure) }),
    ClickedRemove: ({ accountId }) => ({
      model: modifyFields(model, {
        maybeRemoving: () => Option.some(accountId),
        maybeNotice: () => Option.none(),
        maybeDone: () => Option.none(),
      }),
    }),
    CancelledRemove: () => ({
      model: modifyFields(model, { maybeRemoving: () => Option.none() }),
    }),
    ConfirmedRemove: () =>
      Option.match(Option.all({ round: model.maybeRound, who: model.maybeRemoving }), {
        onNone: () => ({ model }),
        onSome: ({ round, who }) =>
          model.isSending
            ? { model }
            : {
                model: modifyFields(model, { isSending: () => true }),
                commands: [
                  RemoveRoundReviewer({
                    scope: pageScopeOf(model),
                    revision: round.revision,
                    accountId: who,
                  }),
                ],
              },
      }),
    SucceededRemove: () => reload(model, 'The reviewer was removed from the round.'),
    FailedRemove: ({ failure }) => ({
      model: modifyFields(failedWith(model, failure), {
        maybeRemoving: () => Option.none(),
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

// NOTE: Escape answers the open question with "no".
export const dismissDialog = (model: Model): Update.Return<Model, Message> =>
  update(model, Message.CancelledRemove())

// VIEW

const statusLine = (row: RevisionRow): string =>
  row.status === 'open'
    ? 'Open for review'
    : row.status === 'superseded'
      ? `Superseded by Revision ${row.replacedBy ?? row.revision + 1}`
      : row.decidedBy === 'deadline'
        ? 'Decided at the deadline'
        : 'Decided, the approval rule was met'

const th = (h: HtmlBuilder<Message>, label: string): Html =>
  h.th(
    [h.Scope('col'), h.Class('px-3 py-2 text-left text-sm font-medium text-msf-grey')],
    [label],
  )

const td = (
  h: HtmlBuilder<Message>,
  children: ReadonlyArray<Html | string>,
  attributes: ReadonlyArray<ReturnType<HtmlBuilder<Message>['Class']>> = [],
): Html =>
  h.td(
    [h.Class('px-3 py-2 align-top text-base text-msf-ink'), ...attributes],
    children,
  )

const fact = (
  h: HtmlBuilder<Message>,
  label: string,
  at: number | undefined,
  empty: string,
): Html =>
  at === undefined
    ? h.span([h.Class('text-msf-grey')], [empty])
    : h.span([h.DataAttribute('at', String(at))], [`${label}${momentText(at)}`])

const scrollBox = (
  h: HtmlBuilder<Message>,
  label: string,
  table: Html,
): Html =>
  h.div(
    [
      h.Role('region'),
      h.AriaLabel(label),
      h.Tabindex(0),
      h.Class(
        clsx(
          'max-w-full overflow-x-auto border-y border-msf-line',
          focusRing,
        ),
      ),
    ],
    [table],
  )

const nameOf = (view: Grid, id: string): string =>
  view.names.find(name => name.id === id)?.name ?? id

const decisionCell = (
  h: HtmlBuilder<Message>,
  cell: RevisionCell,
  votes: boolean,
): Html =>
  h.div(
    [h.Class('flex flex-col gap-1')],
    [
      cell.decision === undefined
        ? h.span(
            [h.Class('text-msf-grey')],
            [votes ? 'No decision yet' : 'Does not vote'],
          )
        : h.span(
            [
              h.Class('font-medium'),
              h.DataAttribute('decision', cell.decision.decision),
            ],
            [
              `${decisionText(cell.decision.decision)}, ${momentText(cell.decision.at)}`,
            ],
          ),
      ...Array.map(
        Array.filter(cell.reviews, review => !review.standing),
        review =>
          h.span(
            [h.Class('text-sm text-msf-grey')],
            [
              `${decisionText(review.decision)}${review.hasComments ? ' with comments' : ''}, ${momentText(review.at)}`,
            ],
          ),
      ),
      cell.reviews.some(review => review.standing && review.hasComments)
        ? h.span([h.Class('text-sm text-msf-grey')], ['With comments'])
        : h.empty,
    ],
  )

const reviewerRow = (
  h: HtmlBuilder<Message>,
  model: Model,
  view: Grid,
  row: RevisionRow,
  cell: RevisionCell,
): Html => {
  const votes = Array.some(row.rule.roles, role => role.roleId === cell.roleId)
  const canRemove =
    mayChangeRound(model) &&
    row.status === 'open' &&
    !cell.removed &&
    Option.exists(model.maybeRound, round => round.revision === row.revision)
  return h.keyed('tr')(
    cell.accountId,
    [
      h.Class('border-b border-msf-line'),
      h.DataAttribute('reviewer', cell.accountId),
      h.DataAttribute('removed', cell.removed ? 'true' : 'false'),
    ],
    [
      h.th(
        [h.Scope('row'), h.Class('px-3 py-2 text-left text-base font-medium text-msf-black')],
        [
          nameOf(view, cell.accountId),
          cell.removed
            ? h.span([h.Class('block text-sm font-normal text-msf-grey')], ['Removed from the round'])
            : '',
        ],
      ),
      td(h, [cell.roleName, votes ? '' : ' (comments only)']),
      td(h, [fact(h, 'Told ', cell.sent?.at, 'Not told yet')]),
      td(h, [fact(h, 'Read ', cell.read?.at, 'Not opened')]),
      td(h, [decisionCell(h, cell, votes)]),
      td(h, [
        Array.match(cell.reminders, {
          onEmpty: () => h.span([h.Class('text-msf-grey')], ['No reminder sent']),
          onNonEmpty: reminders =>
            h.div(
              [h.Class('flex flex-col gap-1')],
              Array.map(reminders, reminder =>
                h.span(
                  [],
                  [
                    `${reminder.kind === 'reminder_final' ? 'Final reminder' : 'Reminder'} ${momentText(reminder.at)}`,
                  ],
                ),
              ),
            ),
        }),
      ]),
      ...(mayChangeRound(model) && row.status === 'open'
        ? [
            td(h, [
              canRemove
                ? actionButton(
                    h,
                    'Remove',
                    `Remove ${nameOf(view, cell.accountId)} from this round`,
                    Message.ClickedRemove({ accountId: cell.accountId }),
                  )
                : '',
            ]),
          ]
        : []),
    ],
  )
}

const ruleLines = (
  h: HtmlBuilder<Message>,
  template: Template,
  row: RevisionRow,
): Html =>
  h.ul(
    [h.AriaLabel(`Approval rule of ${row.label}`), h.Class('flex flex-col gap-1')],
    Array.map(row.rule.roles, role => {
      const roleName =
        template.roles.find(candidate => candidate.id === role.roleId)?.name ??
        role.roleId
      const rule =
        role.rule.kind === 'all'
          ? 'every voter must approve'
          : role.rule.kind === 'majority'
            ? 'more than half must approve'
            : `at least ${role.rule.count} must approve`
      return h.keyed('li')(
        role.roleId,
        [
          h.Class('text-base text-msf-ink'),
          h.DataAttribute('role-rule', role.roleId),
          h.DataAttribute('met', role.met ? 'true' : 'false'),
        ],
        [
          `${roleName}: ${role.approvals} of ${role.voters} approved, ${role.changesRequested} asked for changes. Rule: ${rule}. ${role.met ? 'Met.' : 'Not met.'}`,
        ],
      )
    }),
  )

const revisionSection = (
  h: HtmlBuilder<Message>,
  model: Model,
  template: Template,
  view: Grid,
  row: RevisionRow,
): Html => {
  const showActions = mayChangeRound(model) && row.status === 'open'
  return h.keyed('section')(
    String(row.revision),
    [
      h.AriaLabel(`Grid of ${row.label}`),
      h.DataAttribute('grid-revision', String(row.revision)),
      h.DataAttribute('status', row.status),
      h.Class('flex flex-col gap-3'),
    ],
    [
      h.h2(
        [h.Class('text-2xl font-black text-msf-black')],
        [`${row.label}, from Draft ${row.draft}`],
      ),
      h.p(
        [h.Class('text-lg font-medium text-msf-ink'), h.DataAttribute('round-status', row.status)],
        [statusLine(row)],
      ),
      h.p(
        [h.Class('text-base text-msf-grey')],
        [
          [
            row.publishedAt === undefined ? '' : `Published ${momentText(row.publishedAt)}. `,
            `Deadline ${momentText(row.deadline)}. `,
            row.decidedAt === undefined
              ? ''
              : `Decided ${momentText(row.decidedAt)}${row.decidedBy === 'deadline' ? ' by the deadline' : ' by the approval rule'}.`,
          ].join(''),
        ],
      ),
      ruleLines(h, template, row),
      scrollBox(
        h,
        `Reviewers of ${row.label}`,
        h.table(
          [h.Class('w-full min-w-[44rem] border-collapse text-left')],
          [
            h.thead(
              [],
              [
                h.tr(
                  [h.Class('border-b border-msf-line')],
                  [
                    th(h, 'Reviewer'),
                    th(h, 'Role'),
                    th(h, 'Told'),
                    th(h, 'Read'),
                    th(h, 'Decision'),
                    th(h, 'Reminded'),
                    ...(showActions ? [th(h, 'Round')] : []),
                  ],
                ),
              ],
            ),
            h.tbody(
              [],
              Array.map(row.cells, cell => reviewerRow(h, model, view, row, cell)),
            ),
          ],
        ),
      ),
    ],
  )
}

const draftsTable = (h: HtmlBuilder<Message>, view: Grid): Html =>
  scrollBox(
    h,
    'Shared drafts',
    h.table(
      [h.Class('w-full min-w-[32rem] border-collapse text-left')],
      [
        h.thead(
          [],
          [
            h.tr(
              [h.Class('border-b border-msf-line')],
              [
                th(h, 'Draft'),
                th(h, 'Shared'),
                ...Array.map(view.grid.authors, id => th(h, `Read by ${nameOf(view, id)}`)),
              ],
            ),
          ],
        ),
        h.tbody(
          [],
          Array.map(view.grid.drafts, draft =>
            h.keyed('tr')(
              String(draft.draft),
              [
                h.Class('border-b border-msf-line'),
                h.DataAttribute('grid-draft', String(draft.draft)),
              ],
              [
                h.th(
                  [h.Scope('row'), h.Class('px-3 py-2 text-left text-base font-medium text-msf-black')],
                  [draft.label],
                ),
                td(h, [
                  draft.sharedAt === undefined
                    ? h.span([h.Class('text-msf-grey')], ['The empty template'])
                    : h.span(
                        [],
                        [
                          `${draft.sharedBy === undefined ? '' : `${nameOf(view, draft.sharedBy)}, `}${momentText(draft.sharedAt)}`,
                        ],
                      ),
                ]),
                ...Array.map(draft.cells, cell =>
                  td(h, [
                    fact(h, '', cell.read?.at, draft.sharedAt === undefined ? '' : 'Not read'),
                  ]),
                ),
              ],
            ),
          ),
        ),
      ],
    ),
  )

const removalPanel = (
  h: HtmlBuilder<Message>,
  model: Model,
  template: Template,
  round: typeof RoundView.Type,
  view: Grid,
  accountId: string,
): Html => {
  const removal = removalOf(template, round, accountId)
  const name = nameOf(view, accountId)
  return h.section(
    [
      h.AriaLabel(`Remove ${name}`),
      h.Role('alertdialog'),
      h.DataAttribute('removal', accountId),
      h.Class('flex flex-col gap-3 border-2 border-msf-ink px-4 py-4'),
    ],
    [
      h.h3([h.Class('text-xl font-black text-msf-black')], [`Remove ${name} from this round?`]),
      removal.kind === 'refused'
        ? alertText(h, removal.message)
        : h.div(
            [h.Class('flex flex-col gap-2')],
            [
              h.p(
                [h.Class('text-base text-msf-ink')],
                [
                  'The removal is logged and they are told. The approval rule is worked out again without them:',
                ],
              ),
              h.ul(
                [h.Class('flex flex-col gap-1')],
                Array.map(removal.lines, line =>
                  h.keyed('li')(
                    line.roleId,
                    [h.Class('text-base text-msf-ink')],
                    [line.text],
                  ),
                ),
              ),
              removal.decidesNow
                ? h.p(
                    [h.Class('text-base font-medium text-msf-ink'), h.DataAttribute('decides-now', 'true')],
                    ['With this removal the rule is met, so the round is decided now.'],
                  )
                : h.empty,
            ],
          ),
      h.div(
        [h.Class('flex flex-wrap gap-2')],
        [
          removal.kind === 'refused'
            ? h.empty
            : actionButton(
                h,
                'Remove from the round',
                `Confirm removing ${name}`,
                Message.ConfirmedRemove(),
                model.isSending,
              ),
          actionButton(h, 'Keep in the round', 'Keep in the round', Message.CancelledRemove()),
        ],
      ),
    ],
  )
}

const extendForm = (
  h: HtmlBuilder<Message>,
  model: Model,
  round: typeof RoundView.Type,
): Html =>
  h.div(
    [h.Class('flex flex-col gap-3'), h.DataAttribute('extend-form', String(round.revision))],
    [
      h.p(
        [h.Class('text-base text-msf-ink')],
        [
          `The deadline of Revision ${round.revision} is ${deadlineText(round.deadline.at, round.deadline.timeZone)}. It can only be moved later; the reviewers are told.`,
        ],
      ),
      h.div(
        [h.Class('grid grid-cols-1 gap-4 sm:grid-cols-2')],
        [
          h.div(
            [h.Class('flex flex-col gap-2')],
            [
              h.label([h.Class(labelClassName), h.For('extend-date')], ['New date']),
              h.input([
                h.Id('extend-date'),
                h.Type('date'),
                h.Value(model.extendDate),
                h.Class(fieldClassName),
                h.OnInput(value => Message.TypedExtendDate({ value })),
              ]),
            ],
          ),
          h.div(
            [h.Class('flex flex-col gap-2')],
            [
              h.label([h.Class(labelClassName), h.For('extend-time')], ['New time']),
              h.input([
                h.Id('extend-time'),
                h.Type('time'),
                h.Value(model.extendTime),
                h.Class(fieldClassName),
                h.OnInput(value => Message.TypedExtendTime({ value })),
              ]),
            ],
          ),
        ],
      ),
      selectField(
        h,
        'extend-zone',
        'Time zone',
        model.extendZone,
        Array.map(zoneChoices(model.extendZone), zone => ({ value: zone, label: zone })),
        value => Message.ChoseExtendZone({ value }),
      ),
      actionButton(
        h,
        'Extend the deadline',
        'Extend the deadline',
        Message.SubmittedExtend(),
        model.isSending,
      ),
    ],
  )

const actionsPanel = (
  h: HtmlBuilder<Message>,
  model: Model,
  template: Template,
  view: Grid,
): Html =>
  Option.match(model.maybeRound, {
    onNone: () => h.empty,
    onSome: round =>
      mayChangeRound(model)
        ? panel(
            h,
            `Round actions for Revision ${round.revision}`,
            [
              extendForm(h, model, round),
              Option.match(model.maybeRemoving, {
                onNone: () => h.empty,
                onSome: accountId =>
                  removalPanel(h, model, template, round, view, accountId),
              }),
              h.ul(
                [h.AriaLabel('Rule as it stands'), h.Class('flex flex-col gap-1')],
                Array.map(roleLines(template, round, Option.none()), line =>
                  h.keyed('li')(line.roleId, [h.Class('text-base text-msf-grey')], [line.text]),
                ),
              ),
            ],
            Option.some('Reminders are rewritten for the new deadline. A removal is logged.'),
          )
        : h.empty,
  })

const shell = (
  h: HtmlBuilder<Message>,
  reportId: string,
  children: ReadonlyArray<Html>,
): Html =>
  h.section(
    [h.AriaLabel('Status grid'), h.Class('flex max-w-full flex-col gap-6 pt-10 md:pt-14')],
    [
      h.div(
        [h.Class('flex flex-wrap gap-4')],
        [
          h.a(
            [
              h.Href(pathOf(AppRoute.Report({ reportId }))),
              h.Class(clsx('text-base text-msf-ink underline', focusRing)),
            ],
            ['Back to the report'],
          ),
          h.a(
            [
              h.Href(pathOf(AppRoute.Audit({ reportId }))),
              h.Class(clsx('text-base text-msf-ink underline', focusRing)),
            ],
            ['Audit log'],
          ),
        ],
      ),
      h.h1(
        [
          h.Id('page-heading'),
          h.Class('text-balance text-4xl font-black tracking-[-0.025em] text-msf-black'),
        ],
        ['Status grid'],
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
    Loaded: () =>
      Option.match(Option.all({ template: model.maybeTemplate, grid: model.maybeView }), {
        onNone: () => shell(h, model.reportId, [loadingText(h, 'Loading.')]),
        onSome: ({ template, grid }) =>
          shell(h, model.reportId, [
            h.p(
              [h.Class('text-base text-msf-grey')],
              ['Every time is shown in your own time zone. A fact that was not recorded is not shown as a time.'],
            ),
            Option.match(model.maybeNotice, {
              onNone: () => h.empty,
              onSome: notice => alertText(h, notice),
            }),
            Option.match(model.maybeDone, {
              onNone: () => h.empty,
              onSome: done => statusText(h, done),
            }),
            actionsPanel(h, model, template, grid),
            panel(
              h,
              'Revisions',
              [
                Array.match(grid.grid.revisions, {
                  onEmpty: () =>
                    h.p([h.Class('text-lg text-msf-grey')], ['No revision has been published.']),
                  onNonEmpty: rows =>
                    h.div(
                      [h.Class('flex flex-col gap-8')],
                      Array.map(Array.reverse(rows), row =>
                        revisionSection(h, model, template, grid, row),
                      ),
                    ),
                }),
              ],
            ),
            panel(h, 'Drafts', [draftsTable(h, grid)]),
          ]),
      }),
  }),
)
