import { clsx } from 'clsx'
import { Array, Effect, Option, Record, Schema } from 'effect'
import { Command, Submodel, Update } from 'foldkit'
import { Html, HtmlBuilder } from 'foldkit/html'
import { defineMessageUnion } from 'foldkit/message'
import { modifyFields } from 'foldkit/struct'

import {
  AuthorCommentView,
  ReportDetail,
  RevisionHeader,
  Template,
} from '@quoroom/domain'

import { AppRoute, pathOf } from '../route'
import { focusRing } from '../style'
import { withQuoroom } from './api'
import { findItem, findSection, momentText, topLevelSections } from './draftText'
import { actionButton } from './entryViews'
import { Failure, failureOf, failureText } from './failure'
import { PageScope, isCurrentPage, pageScopeOf } from './scope'
import { alertText, loadingText } from './ui'
import { LoadState } from './unit'

// NOTE: What reviewers said about each revision, for the authors.
// Every comment is read in the view it was written in; a comment of a `full`
// reviewer shared with the committee also shows the text the redacted readers
// were given. Authors reply (a reply is seen by whoever sees the comment) and
// resolve.

export const RevisionComments = Schema.Struct({
  revision: RevisionHeader,
  comments: Schema.Array(AuthorCommentView),
})

export const LoadedComments = Schema.Struct({
  detail: ReportDetail,
  template: Template,
  groups: Schema.Array(RevisionComments),
})
export type LoadedComments = typeof LoadedComments.Type

export const Model = Schema.Struct({
  origin: Schema.String,
  reportId: Schema.String,
  generation: Schema.Int,
  load: LoadState,
  maybeDetail: Schema.Option(ReportDetail),
  maybeTemplate: Schema.Option(Template),
  groups: Schema.Array(RevisionComments),
  replyTexts: Schema.Record(Schema.String, Schema.String),
  isSending: Schema.Boolean,
  maybeNotice: Schema.Option(Schema.String),
})
export type Model = typeof Model.Type

export const initialModel = Model.make({
  origin: '',
  reportId: '',
  generation: 0,
  load: LoadState.Loading(),
  maybeDetail: Option.none(),
  maybeTemplate: Option.none(),
  groups: [],
  replyTexts: {},
  isSending: false,
  maybeNotice: Option.none(),
})

export const Message = defineMessageUnion({
  SucceededLoadComments: { scope: PageScope, loaded: LoadedComments },
  FailedLoadComments: { scope: PageScope, failure: Failure },
  ClickedRetryLoad: {},
  TypedReply: { commentId: Schema.String, text: Schema.String },
  SubmittedReply: { commentId: Schema.String },
  SucceededReply: { scope: PageScope, comment: AuthorCommentView },
  FailedReply: { scope: PageScope, failure: Failure },
  ClickedResolve: { commentId: Schema.String, resolved: Schema.Boolean },
  SucceededResolve: { scope: PageScope, comment: AuthorCommentView },
  FailedResolve: { scope: PageScope, failure: Failure },
})
export type Message = typeof Message.Type

// COMMAND

export const LoadComments = Command.define('LoadComments', {
  args: { scope: PageScope },
  messages: [Message.SucceededLoadComments, Message.FailedLoadComments],
  execute: ({ scope, scope: { reportId } }) =>
    withQuoroom(client =>
      Effect.gen(function* () {
        const detail = yield* client.GetReport({ reportId })
        const version = yield* client.GetTemplateVersion({
          templateId: detail.summary.templateId,
          version: detail.summary.templateVersion,
          reportId,
        })
        const history = yield* client.GetHistory({ reportId })
        const groups = yield* Effect.all(
          Array.map(history.revisions, revision =>
            client
              .ListRevisionComments({ reportId, revision: revision.number })
              .pipe(Effect.map(comments => ({ revision, comments }))),
          ),
        )
        return { detail, template: version.template, groups }
      }),
    ).pipe(
      Effect.map(loaded => Message.SucceededLoadComments({ scope, loaded })),
      Effect.catch(error =>
        Effect.succeed(
          Message.FailedLoadComments({ scope, failure: failureOf(error) }),
        ),
      ),
    ),
})

export const ReplyToRevisionComment = Command.define('ReplyToRevisionComment', {
  args: {
    scope: PageScope,
    commentId: Schema.String,
    body: Schema.String,
  },
  messages: [Message.SucceededReply, Message.FailedReply],
  execute: ({ scope, scope: { reportId }, commentId, body }) =>
    withQuoroom(client =>
      client.ReplyToComment({ reportId, commentId, body }),
    ).pipe(
      Effect.map(comment => Message.SucceededReply({ scope, comment })),
      Effect.catch(error =>
        Effect.succeed(
          Message.FailedReply({ scope, failure: failureOf(error) }),
        ),
      ),
    ),
})

export const SetRevisionCommentResolved = Command.define('SetRevisionCommentResolved', {
  args: {
    scope: PageScope,
    commentId: Schema.String,
    resolved: Schema.Boolean,
  },
  messages: [Message.SucceededResolve, Message.FailedResolve],
  execute: ({ scope, scope: { reportId }, commentId, resolved }) =>
    withQuoroom(client =>
      client.ResolveComment({ reportId, commentId, resolved }),
    ).pipe(
      Effect.map(comment => Message.SucceededResolve({ scope, comment })),
      Effect.catch(error =>
        Effect.succeed(
          Message.FailedResolve({ scope, failure: failureOf(error) }),
        ),
      ),
    ),
})

// QUERIES

export const mayReply = (model: Model): boolean =>
  Option.exists(model.maybeDetail, detail =>
    Array.contains(detail.permissions, 'reply'),
  )

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
    commands: [LoadComments({ scope: pageScopeOf(fresh) })],
  }
}

export const cleared = (model: Model): Model =>
  modifyFields(initialModel, { generation: () => model.generation + 1 })

// UPDATE

const replaceComment = (
  model: Model,
  comment: typeof AuthorCommentView.Type,
): Model =>
  modifyFields(model, {
    groups: groups =>
      Array.map(groups, group => ({
        ...group,
        comments: Array.map(group.comments, existing =>
          existing.id === comment.id ? comment : existing,
        ),
      })),
  })

const failedWith = (model: Model, failure: Failure): Model =>
  modifyFields(model, {
    isSending: () => false,
    maybeNotice: () => Option.some(failureText(failure)),
  })

const updateCurrent = (
  model: Model,
  message: Message,
): Update.Return<Model, Message> =>
  Message.match<Update.Return<Model, Message>>(message, {
    SucceededLoadComments: ({ loaded }) => ({
      model: modifyFields(model, {
        load: () => LoadState.Loaded(),
        maybeDetail: () => Option.some(loaded.detail),
        maybeTemplate: () => Option.some(loaded.template),
        groups: () => loaded.groups,
      }),
    }),
    FailedLoadComments: ({ failure }) => ({
      model: modifyFields(model, { load: () => LoadState.Failed({ failure }) }),
    }),
    ClickedRetryLoad: () => ({
      model: modifyFields(model, { load: () => LoadState.Loading() }),
      commands: [LoadComments({ scope: pageScopeOf(model) })],
    }),
    TypedReply: ({ commentId, text }) => ({
      model: modifyFields(model, {
        replyTexts: texts => Record.set(texts, commentId, text),
      }),
    }),
    SubmittedReply: ({ commentId }) => {
      const body = (model.replyTexts[commentId] ?? '').trim()
      return body === '' || model.isSending
        ? { model }
        : {
            model: modifyFields(model, {
              isSending: () => true,
              maybeNotice: () => Option.none(),
            }),
            commands: [
              ReplyToRevisionComment({
                scope: pageScopeOf(model),
                commentId,
                body,
              }),
            ],
          }
    },
    SucceededReply: ({ comment }) => ({
      model: modifyFields(replaceComment(model, comment), {
        isSending: () => false,
        replyTexts: texts => Record.remove(texts, comment.id),
      }),
    }),
    FailedReply: ({ failure }) => ({ model: failedWith(model, failure) }),
    ClickedResolve: ({ commentId, resolved }) => ({
      model: modifyFields(model, { maybeNotice: () => Option.none() }),
      commands: [
        SetRevisionCommentResolved({ scope: pageScopeOf(model), commentId, resolved }),
      ],
    }),
    SucceededResolve: ({ comment }) => ({
      model: replaceComment(model, comment),
    }),
    FailedResolve: ({ failure }) => ({ model: failedWith(model, failure) }),
  })

export const update = (
  model: Model,
  message: Message,
): Update.Return<Model, Message> =>
  'scope' in message && !isCurrentPage(model, message.scope)
    ? { model }
    : updateCurrent(model, message)

// VIEW

const locationText = (
  template: Template,
  comment: typeof AuthorCommentView.Type,
): string => {
  const section = findSection(
    topLevelSections(template),
    comment.anchor.sectionId,
  )
  const title = Option.match(section, {
    onNone: () => comment.anchor.sectionId,
    onSome: found => found.title,
  })
  if (comment.anchor.kind !== 'text') {
    return title
  }
  const itemId = comment.anchor.itemId
  const item = Option.flatMap(section, found => findItem(found, itemId))
  return `${title} › ${Option.match(item, {
    onNone: () => itemId,
    onSome: found => found.label,
  })}`
}

const commentCard = (
  h: HtmlBuilder<Message>,
  model: Model,
  template: Template,
  comment: typeof AuthorCommentView.Type,
): Html =>
  h.keyed('li')(
    comment.id,
    [
      h.Class(
        clsx('flex flex-col gap-3 py-4', comment.resolved && 'text-brand-grey'),
      ),
      h.DataAttribute('comment', comment.id),
      h.DataAttribute('visibility', comment.visibility),
      h.DataAttribute('resolved', comment.resolved ? 'true' : 'false'),
    ],
    [
      h.p(
        [h.Class('text-base text-brand-grey')],
        [
          `${comment.authorName}, ${momentText(comment.createdAt)}, on ${locationText(template, comment)}`,
          comment.resolved ? ' · Resolved' : '',
        ],
      ),
      h.p(
        [h.Class('text-sm font-medium text-brand-ink')],
        [
          comment.visibility === 'committee'
            ? 'Shared with the whole committee'
            : 'Authors only',
        ],
      ),
      comment.anchor.kind === 'text'
        ? h.blockquote(
            [
              h.Class(
                'border-l-4 border-brand-line pl-3 text-lg italic text-brand-ink',
              ),
            ],
            [comment.anchor.quoted],
          )
        : h.empty,
      h.p(
        [h.Class('whitespace-pre-wrap text-lg text-brand-ink')],
        [comment.body],
      ),
      comment.redactedBody === undefined
        ? h.empty
        : h.p(
            [
              h.Class(
                'whitespace-pre-wrap border-l-4 border-brand-line pl-3 text-base text-brand-grey',
              ),
              h.DataAttribute('redacted-twin', 'true'),
            ],
            [`As the redacted readers see it: ${comment.redactedBody}`],
          ),
      ...Array.map(comment.replies, reply =>
        h.keyed('div')(
          reply.id,
          [
            h.Class('ml-4 flex flex-col gap-1 border-l-2 border-brand-line pl-3'),
            h.DataAttribute('reply', reply.id),
          ],
          [
            h.p(
              [h.Class('text-sm text-brand-grey')],
              [`${reply.authorName}, ${momentText(reply.createdAt)}`],
            ),
            h.p(
              [h.Class('whitespace-pre-wrap text-lg text-brand-ink')],
              [reply.body],
            ),
          ],
        ),
      ),
      mayReply(model)
        ? h.div(
            [h.Class('flex flex-col gap-2')],
            [
              h.label(
                [
                  h.Class('text-base font-medium text-brand-ink'),
                  h.For(`reply-${comment.id}`),
                ],
                ['Reply'],
              ),
              h.textarea([
                h.Id(`reply-${comment.id}`),
                h.Value(model.replyTexts[comment.id] ?? ''),
                h.Class(
                  clsx(
                    'min-h-20 w-full border border-brand-line bg-white px-3 py-2 text-lg',
                    focusRing,
                  ),
                ),
                h.OnInput(text =>
                  Message.TypedReply({ commentId: comment.id, text }),
                ),
              ]),
              h.div(
                [h.Class('flex flex-wrap gap-2')],
                [
                  actionButton(
                    h,
                    'Send reply',
                    'Send reply to this comment',
                    Message.SubmittedReply({ commentId: comment.id }),
                    (model.replyTexts[comment.id] ?? '').trim() === '' ||
                      model.isSending,
                  ),
                  actionButton(
                    h,
                    comment.resolved ? 'Reopen' : 'Resolve',
                    comment.resolved
                      ? 'Reopen this comment'
                      : 'Resolve this comment',
                    Message.ClickedResolve({
                      commentId: comment.id,
                      resolved: !comment.resolved,
                    }),
                  ),
                ],
              ),
            ],
          )
        : h.empty,
    ],
  )

const groupView = (
  h: HtmlBuilder<Message>,
  model: Model,
  template: Template,
  group: typeof RevisionComments.Type,
): Html =>
  h.keyed('section')(
    String(group.revision.number),
    [
      h.AriaLabel(`Comments on ${group.revision.label}`),
      h.DataAttribute('revision-comments', String(group.revision.number)),
      h.Class('flex flex-col gap-3'),
    ],
    [
      h.h2(
        [h.Class('text-2xl font-black text-brand-ink')],
        [`Comments on ${group.revision.label}`],
      ),
      Array.match(group.comments, {
        onEmpty: () =>
          h.p([h.Class('text-lg text-brand-grey')], ['No comments yet.']),
        onNonEmpty: list =>
          h.ul(
            [
              h.AriaLabel(`Comments on ${group.revision.label}`),
              h.Class(
                'flex flex-col divide-y divide-brand-line border-y border-brand-line',
              ),
            ],
            Array.map(list, comment => commentCard(h, model, template, comment)),
          ),
      }),
    ],
  )

const shell = (
  h: HtmlBuilder<Message>,
  reportId: string,
  children: ReadonlyArray<Html>,
): Html =>
  h.section(
    [
      h.AriaLabel('Comments from reviewers'),
      h.Class('flex flex-col gap-6 pt-10 md:pt-14'),
    ],
    [
      h.a(
        [
          h.Href(pathOf(AppRoute.Report({ reportId }))),
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
        ['Comments from reviewers'],
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
      Option.match(model.maybeTemplate, {
        onNone: () => shell(h, model.reportId, [loadingText(h, 'Loading.')]),
        onSome: template =>
          shell(h, model.reportId, [
            Option.match(model.maybeNotice, {
              onNone: () => h.empty,
              onSome: notice => alertText(h, notice),
            }),
            Array.match(model.groups, {
              onEmpty: () =>
                h.p(
                  [h.Class('text-lg text-brand-grey')],
                  ['No revision has been published yet.'],
                ),
              onNonEmpty: groups =>
                h.div(
                  [h.Class('flex flex-col gap-8')],
                  Array.map(groups, group =>
                    groupView(h, model, template, group),
                  ),
                ),
            }),
          ]),
      }),
  }),
)
