import { clsx } from 'clsx'
import {
  Array,
  Clock,
  Duration,
  Effect,
  Option,
  Result,
  Schema,
  Stream,
} from 'effect'
import { Command, Submodel, Subscription, Update } from 'foldkit'
import { Html, HtmlBuilder } from 'foldkit/html'
import { defineMessageUnion } from 'foldkit/message'
import { modifyFields } from 'foldkit/struct'

import {
  PublishChoices,
  ReportDetail,
  RevisionHeader,
  RoundView,
  Template,
  draftLabel,
  nextRevisionNumber,
} from '@quoroom/domain'

import { AppRoute, pathOf } from '../route'
import { focusRing } from '../style'
import { withQuoroom } from './api'
import { actionButton } from './entryViews'
import { Failure, failureOf, failureText } from './failure'
import * as PublishForm from './publishForm'
import { currentRoundOf, revisionsList, roundLine } from './rounds'
import { PageScope, isCurrentPage, pageScopeOf } from './scope'
import { alertText, loadingText, panel } from './ui'
import { LoadState } from './unit'

// NOTE: Publishing and rounds, at `/r/:id/publish`. The author
// publishes the latest shared draft as the next revision with a deadline and,
// for every reviewing role, a committee or a list of people (D23). The screen
// also shows the open round with its deadline and countdown, the revisions and
// whether each is still open or was superseded (D11). Reviewers are told in
// Quoroom (D17).

const CLOCK_TICK_SECONDS = 30

export const Model = Schema.Struct({
  origin: Schema.String,
  reportId: Schema.String,
  generation: Schema.Int,
  load: LoadState,
  maybeDetail: Schema.Option(ReportDetail),
  maybeTemplate: Schema.Option(Template),
  maybeChoices: Schema.Option(PublishChoices),
  revisions: Schema.Array(RevisionHeader),
  maybeRound: Schema.Option(RoundView),
  form: PublishForm.Model,
  nowMs: Schema.Int,
  isPublishing: Schema.Boolean,
  problems: Schema.Array(Schema.String),
  maybePublished: Schema.Option(Schema.Int),
  maybeFailure: Schema.Option(Failure),
})
export type Model = typeof Model.Type

export const initialModel = Model.make({
  origin: '',
  reportId: '',
  generation: 0,
  load: LoadState.Loading(),
  maybeDetail: Option.none(),
  maybeTemplate: Option.none(),
  maybeChoices: Option.none(),
  revisions: [],
  maybeRound: Option.none(),
  form: PublishForm.initialModel,
  nowMs: 0,
  isPublishing: false,
  problems: [],
  maybePublished: Option.none(),
  maybeFailure: Option.none(),
})

export const LoadedPublish = Schema.Struct({
  detail: ReportDetail,
  template: Template,
  choices: PublishChoices,
  revisions: Schema.Array(RevisionHeader),
  maybeRound: Schema.Option(RoundView),
  nowMs: Schema.Int,
  timeZone: Schema.String,
})
export type LoadedPublish = typeof LoadedPublish.Type

export const Message = defineMessageUnion({
  SucceededLoadPublish: { scope: PageScope, loaded: LoadedPublish },
  FailedLoadPublish: { scope: PageScope, failure: Failure },
  ClickedRetryLoad: {},
  GotFormMessage: { message: PublishForm.Message },
  ClickedPublish: {},
  SucceededPublishRevision: { scope: PageScope, revision: RevisionHeader },
  FailedPublishRevision: { scope: PageScope, failure: Failure },
  TickedClock: { nowMs: Schema.Int },
})
export type Message = typeof Message.Type

// COMMAND

export const LoadPublish = Command.define('LoadPublish', {
  args: { scope: PageScope },
  messages: [Message.SucceededLoadPublish, Message.FailedLoadPublish],
  execute: ({ scope, scope: { reportId } }) =>
    withQuoroom(client =>
      Effect.gen(function* () {
        const detail = yield* client.GetReport({ reportId })
        const version = yield* client.GetTemplateVersion({
          templateId: detail.summary.templateId,
          version: detail.summary.templateVersion,
          reportId,
        })
        const choices = yield* client.GetPublishChoices({ reportId })
        const history = yield* client.GetHistory({ reportId })
        const open = Array.findLast(
          history.revisions,
          revision => revision.status === 'open',
        )
        const maybeRound = Option.isSome(open)
          ? Option.some(
              yield* client.GetRound({
                reportId,
                revision: open.value.number,
              }),
            )
          : Option.none()
        const nowMs = yield* Clock.currentTimeMillis
        return {
          detail,
          template: version.template,
          choices,
          revisions: history.revisions,
          maybeRound,
          nowMs,
          timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        }
      }),
    ).pipe(
      Effect.map(loaded => Message.SucceededLoadPublish({ scope, loaded })),
      Effect.catch(error =>
        Effect.succeed(
          Message.FailedLoadPublish({ scope, failure: failureOf(error) }),
        ),
      ),
    ),
})

export const PublishRevision = Command.define('PublishRevision', {
  args: {
    scope: PageScope,
    draft: Schema.Int,
    terms: Schema.Struct({
      deadline: Schema.Struct({ at: Schema.Number, timeZone: Schema.String }),
      selections: Schema.Array(
        Schema.Struct({
          roleId: Schema.String,
          sources: Schema.Array(
            Schema.Union([
              Schema.Struct({
                kind: Schema.Literal('committee'),
                committeeId: Schema.String,
              }),
              Schema.Struct({
                kind: Schema.Literal('account'),
                accountId: Schema.String,
              }),
            ]),
          ),
        }),
      ),
      closing: Schema.Boolean,
    }),
  },
  messages: [Message.SucceededPublishRevision, Message.FailedPublishRevision],
  execute: ({ scope, draft, terms }) =>
    withQuoroom(client =>
      client.PublishRevision({ reportId: scope.reportId, draft, terms }),
    ).pipe(
      Effect.map(result =>
        Message.SucceededPublishRevision({ scope, revision: result.revision }),
      ),
      Effect.catch(error =>
        Effect.succeed(
          Message.FailedPublishRevision({ scope, failure: failureOf(error) }),
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
    commands: [LoadPublish({ scope: pageScopeOf(fresh) })],
  }
}

export const cleared = (model: Model): Model =>
  modifyFields(initialModel, { generation: () => model.generation + 1 })

// QUERIES

export const contextOf = (
  model: Model,
): Option.Option<PublishForm.FormContext> =>
  Option.map(
    Option.all({
      detail: model.maybeDetail,
      template: model.maybeTemplate,
      choices: model.maybeChoices,
    }),
    ({ detail, template, choices }) => ({
      template,
      unit: detail.summary.caseFile.unit,
      authors: Array.map(detail.authors, author => author.id),
      choices,
      nowMs: model.nowMs,
    }),
  )

const PREVIEW_NEEDED =
  'This draft was shared without the redacted version being checked. Reviewers of a redacted role only ever read that version, so it has to be checked first: share the draft from the share screen, which shows it and asks you to confirm it.'

// UPDATE

const publishClicked = (model: Model): Update.Return<Model, Message> =>
  Option.match(
    Option.all({ context: contextOf(model), choices: model.maybeChoices }),
    {
      onNone: () => ({ model }),
      onSome: ({ context, choices }) => {
        if (choices.latestDraft < 1) {
          return {
            model: modifyFields(model, {
              problems: () => [
                'Share a draft first. There is nothing to publish yet.',
              ],
            }),
          }
        }
        const terms = PublishForm.termsOf(model.form, context)
        if (Result.isFailure(terms)) {
          return {
            model: modifyFields(model, { problems: () => terms.failure }),
          }
        }
        if (
          PublishForm.needsRedactionPreview(model.form, context) &&
          !choices.redactionConfirmed
        ) {
          return {
            model: modifyFields(model, { problems: () => [PREVIEW_NEEDED] }),
          }
        }
        return {
          model: modifyFields(model, {
            isPublishing: () => true,
            problems: () => [],
            maybeFailure: () => Option.none(),
          }),
          commands: [
            PublishRevision({
              scope: pageScopeOf(model),
              draft: choices.latestDraft,
              terms: terms.success,
            }),
          ],
        }
      },
    },
  )

const updateCurrent = (model: Model, message: Message) =>
  Message.match<Update.Return<Model, Message>>(message, {
    SucceededLoadPublish: ({ loaded }) => ({
      model: modifyFields(model, {
        load: () => LoadState.Loaded(),
        maybeDetail: () => Option.some(loaded.detail),
        maybeTemplate: () => Option.some(loaded.template),
        maybeChoices: () => Option.some(loaded.choices),
        revisions: () => loaded.revisions,
        maybeRound: () => loaded.maybeRound,
        nowMs: () => loaded.nowMs,
        form: () => PublishForm.defaultsFor(loaded.nowMs, loaded.timeZone),
        isPublishing: () => false,
      }),
    }),
    FailedLoadPublish: ({ failure }) => ({
      model: modifyFields(model, { load: () => LoadState.Failed({ failure }) }),
    }),
    ClickedRetryLoad: () => ({
      model: modifyFields(model, { load: () => LoadState.Loading() }),
      commands: [LoadPublish({ scope: pageScopeOf(model) })],
    }),
    GotFormMessage: ({ message: formMessage }) => {
      const formUpdate = PublishForm.update(model.form, formMessage)
      return {
        model: modifyFields(model, {
          form: () => formUpdate.model,
          problems: () => [],
        }),
      }
    },
    ClickedPublish: () =>
      model.isPublishing ? { model } : publishClicked(model),
    SucceededPublishRevision: ({ revision }) => ({
      model: modifyFields(model, {
        load: () => LoadState.Loading(),
        maybePublished: () => Option.some(revision.number),
      }),
      commands: [LoadPublish({ scope: pageScopeOf(model) })],
    }),
    FailedPublishRevision: ({ failure }) => ({
      model: modifyFields(model, {
        isPublishing: () => false,
        maybeFailure: () => Option.some(failure),
      }),
    }),
    TickedClock: ({ nowMs }) => ({
      model: modifyFields(model, { nowMs: () => nowMs }),
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

export const subscriptions = Subscription.make<Model, Message>()(entry => ({
  publishClock: entry(
    { isLoaded: Schema.Boolean },
    {
      modelToDependencies: model => ({
        isLoaded: LoadState.guards.Loaded(model.load),
      }),
      dependenciesToStream: ({ isLoaded }) =>
        Stream.tick(Duration.seconds(CLOCK_TICK_SECONDS)).pipe(
          Stream.mapEffect(() => Clock.currentTimeMillis),
          Stream.map(nowMs => Message.TickedClock({ nowMs })),
          Stream.when(Effect.sync(() => isLoaded)),
        ),
    },
  ),
}))

// VIEW

const shell = (
  h: HtmlBuilder<Message>,
  model: Model,
  children: ReadonlyArray<Html>,
): Html =>
  h.section(
    [
      h.AriaLabel('Publish for review'),
      h.Class('flex max-w-3xl flex-col gap-8 pb-14 pt-10 md:pt-14'),
    ],
    [
      h.a(
        [
          h.Href(pathOf(AppRoute.Report({ reportId: model.reportId }))),
          h.Class(
            clsx('self-start text-base text-brand-ink underline', focusRing),
          ),
        ],
        ['Back to the report'],
      ),
      h.h1(
        [
          h.Id('page-heading'),
          h.Class(
            'text-balance text-4xl font-black tracking-[-0.025em] text-brand-ink',
          ),
        ],
        ['Publish for review'],
      ),
      ...children,
    ],
  )

const roundsPanel = (h: HtmlBuilder<Message>, model: Model): Html =>
  panel(
    h,
    'Review rounds',
    [
      Option.match(currentRoundOf(model.revisions), {
        onNone: () =>
          h.p([h.Class('text-lg text-brand-ink')], ['No round is open.']),
        onSome: revision =>
          h.p(
            [
              h.Class('text-lg font-medium text-brand-ink'),
              h.DataAttribute('current-round', String(revision.number)),
            ],
            [`${revision.label} is open. ${roundLine(revision, model.nowMs)}`],
          ),
      }),
      revisionsList(h, model.revisions, model.nowMs),
    ],
    Option.some(
      'Only the latest revision counts. Publishing a new one replaces the open round.',
    ),
  )

const publishPanel = (
  h: HtmlBuilder<Message>,
  model: Model,
  context: PublishForm.FormContext,
  detail: typeof ReportDetail.Type,
): Html => {
  const choices = context.choices
  const next = nextRevisionNumber(
    model.revisions.map(revision => revision.number),
  )
  const hasOpen = Option.isSome(currentRoundOf(model.revisions))
  const archived = detail.summary.state === 'archived'
  const needsPreview =
    PublishForm.needsRedactionPreview(model.form, context) &&
    !choices.redactionConfirmed
  return panel(
    h,
    `Publish Revision ${next}`,
    archived
      ? [
          h.p(
            [h.Class('text-lg text-brand-ink')],
            ['This report is archived. It can be read, not changed.'],
          ),
        ]
      : choices.latestDraft < 1
        ? [
            h.p(
              [h.Class('text-lg text-brand-ink')],
              ['Nothing has been shared yet. Share a draft first.'],
            ),
            shareLink(h, model, 'Share your working copy'),
          ]
        : [
            h.p(
              [h.Class('text-lg text-brand-ink')],
              [
                `Revision ${next} is the latest shared draft, ${draftLabel(choices.latestDraft)}. A shared draft never changes.`,
              ],
            ),
            hasOpen
              ? h.p(
                  [
                    h.Role('note'),
                    h.Class('text-base font-medium text-brand-ink'),
                  ],
                  [
                    `Publishing it replaces the open round. The reviewers of Revision ${next - 1} are told that it was replaced.`,
                  ],
                )
              : h.empty,
            choices.hasUnsharedChanges
              ? h.div(
                  [h.Class('flex flex-col gap-2')],
                  [
                    h.p(
                      [h.Class('text-base text-brand-grey')],
                      [
                        'Your working copy has changes that are not shared. They are not in this revision. To publish them, share and publish from the share screen, which first shows the redacted version.',
                      ],
                    ),
                    shareLink(h, model, 'Share and publish my working copy'),
                  ],
                )
              : h.empty,
            PublishForm.view(h, model.form, context, message =>
              Message.GotFormMessage({ message }),
            ),
            needsPreview
              ? h.div(
                  [
                    h.Class('flex flex-col gap-2'),
                    h.DataAttribute('preview-needed', 'true'),
                  ],
                  [
                    alertText(h, PREVIEW_NEEDED),
                    h.a(
                      [
                        h.Href(
                          pathOf(
                            AppRoute.Draft({
                              reportId: model.reportId,
                              draft: choices.latestDraft,
                            }),
                          ),
                        ),
                        h.Class(
                          clsx(
                            'self-start text-lg text-brand-ink underline',
                            focusRing,
                          ),
                        ),
                      ],
                      [`Read ${draftLabel(choices.latestDraft)}`],
                    ),
                  ],
                )
              : h.empty,
            ...Array.map(model.problems, problem => alertText(h, problem)),
            Option.match(model.maybeFailure, {
              onNone: () => h.empty,
              onSome: failure => alertText(h, failureText(failure)),
            }),
            h.button(
              [
                h.Type('button'),
                h.Disabled(model.isPublishing),
                h.Class(
                  clsx(
                    'inline-flex min-h-12 cursor-pointer items-center justify-center self-start bg-brand-primary px-6 text-lg font-medium text-white transition-colors hover:bg-brand-ink disabled:cursor-wait disabled:opacity-70',
                    focusRing,
                  ),
                ),
                h.OnClick(Message.ClickedPublish()),
              ],
              [model.isPublishing ? 'Publishing…' : `Publish Revision ${next}`],
            ),
          ],
  )
}

const shareLink = (
  h: HtmlBuilder<Message>,
  model: Model,
  label: string,
): Html =>
  h.a(
    [
      h.Href(pathOf(AppRoute.Share({ reportId: model.reportId }))),
      h.Class(clsx('self-start text-lg text-brand-ink underline', focusRing)),
    ],
    [label],
  )

export const view = Submodel.defineView<Model, Message>((model, h) =>
  LoadState.match(model.load, {
    Loading: () => shell(h, model, [loadingText(h, 'Loading.')]),
    Failed: ({ failure }) =>
      shell(h, model, [
        failure._tag === 'NotAllowed'
          ? alertText(h, 'This report is not available to you.')
          : alertText(h, failureText(failure)),
        actionButton(h, 'Try again', 'Try again', Message.ClickedRetryLoad()),
      ]),
    Loaded: () =>
      Option.match(
        Option.all({
          detail: model.maybeDetail,
          context: contextOf(model),
        }),
        {
          onNone: () => shell(h, model, [loadingText(h, 'Loading.')]),
          onSome: ({ detail, context }) =>
            shell(h, model, [
              Option.match(model.maybePublished, {
                onNone: () => h.empty,
                onSome: number =>
                  h.p(
                    [
                      h.Role('status'),
                      h.DataAttribute('published', String(number)),
                      h.Class('text-2xl font-black text-brand-ink'),
                    ],
                    [`Revision ${number} is published.`],
                  ),
              }),
              roundsPanel(h, model),
              publishPanel(h, model, context, detail),
            ]),
        },
      ),
  }),
)
