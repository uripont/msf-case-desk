import { clsx } from 'clsx'
import { Array, Effect, Option, Schema, Stream } from 'effect'
import { Command, Dom, Submodel, Subscription, Update } from 'foldkit'
import { Html, HtmlBuilder } from 'foldkit/html'
import { defineMessageUnion } from 'foldkit/message'
import { defineTaggedUnion } from 'foldkit/schema'
import { modifyFields } from 'foldkit/struct'

import {
  AnchoredCommentView,
  CommentVisibilityName,
  ReviewDecisionSchema,
  ReviewResult,
  ReviewerCommentView,
  RevisionOutline,
  SectionContent,
  Template,
} from '@case-desk/domain'

import { AppRoute, pathOf } from '../route'
import { focusRing } from '../style'
import { withQuoroom } from './api'
import { type ItemHighlight, readOnlySection } from './contentView'
import { findItem, findSection, momentText, topLevelSections } from './draftText'
import { actionButton } from './entryViews'
import { Failure, failureOf, failureText } from './failure'
import { imageContextToken } from './images/spec'
import { decisionText, zoneNote } from './rounds'
import { PageScope, isCurrentPage, pageScopeOf } from './scope'
import { CommentSelection, readCommentSelection } from './selection'
import { alertText, loadingText, panel, statusText } from './ui'
import { LoadState } from './unit'
import { deadlineText } from './zoned'

// NOTE: The reviewer's reading view of one revision (stages 6b and 6c). The
// server chooses what is read (stored redacted text for a redacted role, the
// original for a full one): nothing here asks for a view. The text is the
// read-only view, never the editor. Comments sit beside the text at desktop
// width and below it at phone width. A comment is on selected text (a
// highlight, anchored in the text-offset scheme of the domain) or on a whole
// section; each has the choice of who sees it, authors only (the default) or
// the whole committee, which stays open until the review is sent. Comments are
// kept on the server in a pending review as they are added, so a lost session
// or a reload loses nothing; sending the review fixes them.

export const Composer = defineTaggedUnion({
  Closed: {},
  OnText: { selection: CommentSelection },
  OnSection: { sectionId: Schema.String },
})
export type Composer = typeof Composer.Type

export const Dialog = defineTaggedUnion({
  Closed: {},
  Choosing: { maybeDecision: Schema.Option(ReviewDecisionSchema) },
  Sending: { decision: ReviewDecisionSchema },
})
export type Dialog = typeof Dialog.Type

export const Editing = Schema.Struct({
  commentId: Schema.String,
  text: Schema.String,
  visibility: CommentVisibilityName,
})

export const Model = Schema.Struct({
  origin: Schema.String,
  reportId: Schema.String,
  revision: Schema.Int,
  generation: Schema.Int,
  load: LoadState,
  maybeOutline: Schema.Option(RevisionOutline),
  maybeTemplate: Schema.Option(Template),
  sectionId: Schema.String,
  maybeSection: Schema.Option(SectionContent),
  isSectionLoading: Schema.Boolean,
  comments: Schema.Array(ReviewerCommentView),
  maybeSelection: Schema.Option(CommentSelection),
  composer: Composer,
  commentText: Schema.String,
  visibility: CommentVisibilityName,
  isSending: Schema.Boolean,
  maybeEditing: Schema.Option(Editing),
  dialog: Dialog,
  maybeSent: Schema.Option(ReviewResult),
  maybeNotice: Schema.Option(Schema.String),
  zone: Schema.String,
})
export type Model = typeof Model.Type

export const initialModel = Model.make({
  origin: '',
  reportId: '',
  revision: 0,
  generation: 0,
  load: LoadState.Loading(),
  maybeOutline: Option.none(),
  maybeTemplate: Option.none(),
  sectionId: '',
  maybeSection: Option.none(),
  isSectionLoading: false,
  comments: [],
  maybeSelection: Option.none(),
  composer: Composer.Closed(),
  commentText: '',
  visibility: 'authors',
  isSending: false,
  maybeEditing: Option.none(),
  dialog: Dialog.Closed(),
  maybeSent: Option.none(),
  maybeNotice: Option.none(),
  zone: 'UTC',
})

export const LoadedReview = Schema.Struct({
  outline: RevisionOutline,
  template: Template,
  sectionId: Schema.String,
  maybeSection: Schema.Option(SectionContent),
  comments: Schema.Array(ReviewerCommentView),
  zone: Schema.String,
})
export type LoadedReview = typeof LoadedReview.Type

export const Message = defineMessageUnion({
  SucceededLoadReview: { scope: PageScope, loaded: LoadedReview },
  FailedLoadReview: { scope: PageScope, failure: Failure },
  ClickedRetryLoad: {},
  SelectedSection: { sectionId: Schema.String },
  SucceededLoadRevisionSection: {
    scope: PageScope,
    sectionId: Schema.String,
    content: SectionContent,
  },
  FailedLoadRevisionSection: { scope: PageScope, failure: Failure },
  ChangedSelection: { maybeSelection: Schema.Option(CommentSelection) },
  ClickedCommentOnText: {},
  ClickedCommentOnSection: {},
  TypedComment: { text: Schema.String },
  ChoseVisibility: { visibility: CommentVisibilityName },
  SubmittedComment: {},
  CancelledComment: {},
  CompletedFocusComposer: {},
  SucceededAddComment: { scope: PageScope, comment: AnchoredCommentView },
  FailedAddComment: { scope: PageScope, failure: Failure },
  ClickedEditComment: { commentId: Schema.String },
  TypedEdit: { text: Schema.String },
  ChoseEditVisibility: { visibility: CommentVisibilityName },
  SubmittedEdit: {},
  CancelledEdit: {},
  SucceededUpdateComment: { scope: PageScope, comment: AnchoredCommentView },
  FailedUpdateComment: { scope: PageScope, failure: Failure },
  ClickedDeleteComment: { commentId: Schema.String },
  SucceededDeleteComment: { scope: PageScope, commentId: Schema.String },
  FailedDeleteComment: { scope: PageScope, failure: Failure },
  ClickedSendReview: {},
  ChoseDecision: { decision: ReviewDecisionSchema },
  ClickedCancelSend: {},
  ClickedConfirmSend: {},
  SucceededSendReview: { scope: PageScope, result: ReviewResult },
  FailedSendReview: { scope: PageScope, failure: Failure },
  SucceededRefreshReview: {
    scope: PageScope,
    outline: RevisionOutline,
    comments: Schema.Array(ReviewerCommentView),
  },
  FailedRefreshReview: { scope: PageScope, failure: Failure },
})
export type Message = typeof Message.Type

// COMMAND

const refreshed = (reportId: string, revision: number) =>
  withQuoroom(client =>
    Effect.all({
      outline: client.GetRevisionOutline({ reportId, revision }),
      comments: client.ListReviewerComments({ reportId, revision }),
    }),
  )

export const LoadReview = Command.define('LoadReview', {
  args: { scope: PageScope, revision: Schema.Int },
  messages: [Message.SucceededLoadReview, Message.FailedLoadReview],
  execute: ({ scope, scope: { reportId }, revision }) =>
    withQuoroom(client =>
      Effect.gen(function* () {
        const outline = yield* client.GetRevisionOutline({ reportId, revision })
        const version = yield* client.GetTemplateVersion({
          templateId: outline.templateId,
          version: outline.templateVersion,
          reportId,
          revision,
        })
        const comments = yield* client
          .ListReviewerComments({ reportId, revision })
          .pipe(Effect.catch(() => Effect.succeed([])))
        const first = Array.findFirst(
          topLevelSections(version.template),
          section =>
            Array.some(outline.sections, ref => ref.sectionId === section.id),
        )
        const sectionId = Option.match(first, {
          onNone: () => '',
          onSome: section => section.id,
        })
        const loaded =
          sectionId === ''
            ? Option.none()
            : Option.some(
                yield* client.GetRevisionSection({
                  reportId,
                  revision,
                  sectionId,
                }),
              )
        const zone = yield* Effect.sync(
          () => Intl.DateTimeFormat().resolvedOptions().timeZone,
        )
        return {
          outline,
          template: version.template,
          sectionId,
          maybeSection: Option.map(loaded, section => section.content),
          comments,
          zone,
        }
      }),
    ).pipe(
      Effect.map(loaded => Message.SucceededLoadReview({ scope, loaded })),
      Effect.catch(error =>
        Effect.succeed(
          Message.FailedLoadReview({ scope, failure: failureOf(error) }),
        ),
      ),
    ),
})

export const LoadRevisionSection = Command.define('LoadRevisionSection', {
  args: { scope: PageScope, revision: Schema.Int, sectionId: Schema.String },
  messages: [
    Message.SucceededLoadRevisionSection,
    Message.FailedLoadRevisionSection,
  ],
  execute: ({ scope, scope: { reportId }, revision, sectionId }) =>
    withQuoroom(client =>
      client.GetRevisionSection({ reportId, revision, sectionId }),
    ).pipe(
      Effect.map(section =>
        Message.SucceededLoadRevisionSection({
          scope,
          sectionId,
          content: section.content,
        }),
      ),
      Effect.catch(error =>
        Effect.succeed(
          Message.FailedLoadRevisionSection({
            scope,
            failure: failureOf(error),
          }),
        ),
      ),
    ),
})

export const AddReviewComment = Command.define('AddReviewComment', {
  args: {
    scope: PageScope,
    revision: Schema.Int,
    composer: Composer,
    body: Schema.String,
    visibility: CommentVisibilityName,
  },
  messages: [Message.SucceededAddComment, Message.FailedAddComment],
  execute: ({
    scope,
    scope: { reportId },
    revision,
    composer,
    body,
    visibility,
  }) =>
    withQuoroom(client =>
      client.AddComment({
        reportId,
        revision,
        body,
        visibility,
        anchor: Composer.match(composer, {
          Closed: () => ({ kind: 'section' as const, sectionId: '' }),
          OnSection: ({ sectionId }) => ({
            kind: 'section' as const,
            sectionId,
          }),
          OnText: ({ selection }) => ({
            kind: 'text' as const,
            sectionId: selection.sectionId,
            itemId: selection.itemId,
            ...(selection.entryPath.length === 0
              ? {}
              : { entryPath: [...selection.entryPath] }),
            from: selection.from,
            to: selection.to,
            quoted: selection.quoted,
          }),
        }),
      }),
    ).pipe(
      Effect.map(comment => Message.SucceededAddComment({ scope, comment })),
      Effect.catch(error =>
        Effect.succeed(
          Message.FailedAddComment({ scope, failure: failureOf(error) }),
        ),
      ),
    ),
})

export const UpdateReviewComment = Command.define('UpdateReviewComment', {
  args: {
    scope: PageScope,
    commentId: Schema.String,
    body: Schema.String,
    visibility: CommentVisibilityName,
  },
  messages: [Message.SucceededUpdateComment, Message.FailedUpdateComment],
  execute: ({ scope, scope: { reportId }, commentId, body, visibility }) =>
    withQuoroom(client =>
      client.UpdatePendingComment({ reportId, commentId, body, visibility }),
    ).pipe(
      Effect.map(comment =>
        Message.SucceededUpdateComment({ scope, comment }),
      ),
      Effect.catch(error =>
        Effect.succeed(
          Message.FailedUpdateComment({ scope, failure: failureOf(error) }),
        ),
      ),
    ),
})

export const DeleteReviewComment = Command.define('DeleteReviewComment', {
  args: { scope: PageScope, commentId: Schema.String },
  messages: [Message.SucceededDeleteComment, Message.FailedDeleteComment],
  execute: ({ scope, scope: { reportId }, commentId }) =>
    withQuoroom(client =>
      client.DeletePendingComment({ reportId, commentId }),
    ).pipe(
      Effect.map(() => Message.SucceededDeleteComment({ scope, commentId })),
      Effect.catch(error =>
        Effect.succeed(
          Message.FailedDeleteComment({ scope, failure: failureOf(error) }),
        ),
      ),
    ),
})

export const SendReview = Command.define('SendReview', {
  args: {
    scope: PageScope,
    revision: Schema.Int,
    decision: ReviewDecisionSchema,
  },
  messages: [Message.SucceededSendReview, Message.FailedSendReview],
  execute: ({ scope, scope: { reportId }, revision, decision }) =>
    withQuoroom(client =>
      client.SendReview({ reportId, revision, decision }),
    ).pipe(
      Effect.map(result => Message.SucceededSendReview({ scope, result })),
      Effect.catch(error =>
        Effect.succeed(
          Message.FailedSendReview({ scope, failure: failureOf(error) }),
        ),
      ),
    ),
})

export const RefreshReview = Command.define('RefreshReview', {
  args: { scope: PageScope, revision: Schema.Int },
  messages: [Message.SucceededRefreshReview, Message.FailedRefreshReview],
  execute: ({ scope, scope: { reportId }, revision }) =>
    refreshed(reportId, revision).pipe(
      Effect.map(({ outline, comments }) =>
        Message.SucceededRefreshReview({ scope, outline, comments }),
      ),
      Effect.catch(error =>
        Effect.succeed(
          Message.FailedRefreshReview({ scope, failure: failureOf(error) }),
        ),
      ),
    ),
})

export const FocusComposer = Command.define('FocusComposer', {
  messages: [Message.CompletedFocusComposer],
  execute: Dom.focus('#new-comment').pipe(
    Effect.catch(() => Effect.void),
    Effect.as(Message.CompletedFocusComposer()),
  ),
})

// QUERIES

export const isRoundOpen = (model: Model): boolean =>
  Option.exists(model.maybeOutline, outline => outline.round.status === 'open')

export const mayComment = (model: Model): boolean =>
  Option.exists(
    model.maybeOutline,
    outline => outline.canComment && outline.round.status === 'open',
  )

export const pendingComments = (
  model: Model,
): ReadonlyArray<ReviewerCommentView> =>
  Array.filter(model.comments, comment => comment.mine && !comment.sent)

export const commentsInSection = (
  model: Model,
  sectionId: string,
): ReadonlyArray<ReviewerCommentView> =>
  Array.filter(model.comments, comment => comment.anchor.sectionId === sectionId)

export const highlightsOf = (
  model: Model,
  sectionId: string,
): ReadonlyArray<ItemHighlight> =>
  Array.flatMap(commentsInSection(model, sectionId), comment =>
    comment.anchor.kind === 'text'
      ? [
          {
            id: comment.id,
            itemKey: [
              ...(comment.anchor.entryPath ?? []),
              comment.anchor.itemId,
            ].join('/'),
            from: comment.anchor.from,
            to: comment.anchor.to,
            quoted: comment.anchor.quoted,
          },
        ]
      : [],
  )

// INIT

export const enter = (
  origin: string,
  reportId: string,
  revision: number,
  generation: number,
): Update.Return<Model, Message> => {
  const fresh = modifyFields(initialModel, {
    origin: () => origin,
    reportId: () => reportId,
    revision: () => revision,
    generation: () => generation,
  })
  return {
    model: fresh,
    commands: [LoadReview({ scope: pageScopeOf(fresh), revision })],
  }
}

export const cleared = (model: Model): Model =>
  modifyFields(initialModel, { generation: () => model.generation + 1 })

// UPDATE

const SESSION_ENDED =
  'Your session has ended. Reload this page to sign in again. Comments you already added are kept.'

const noticeOf = (failure: Failure): string =>
  failure._tag === 'SignInRequired' ? SESSION_ENDED : failureText(failure)

const failedWith = (model: Model, failure: Failure): Model =>
  modifyFields(model, {
    isSending: () => false,
    maybeNotice: () => Option.some(noticeOf(failure)),
  })

const replaceComment = (
  model: Model,
  comment: typeof AnchoredCommentView.Type,
): Model =>
  modifyFields(model, {
    comments: comments =>
      Array.map(comments, existing =>
        existing.id === comment.id ? comment : existing,
      ),
  })

const composerClosed = (model: Model): Model =>
  modifyFields(model, {
    composer: () => Composer.Closed(),
    commentText: () => '',
    visibility: () => 'authors',
    maybeSelection: () => Option.none(),
  })

const updateCurrent = (model: Model, message: Message) =>
  Message.match<Update.Return<Model, Message>>(message, {
    SucceededLoadReview: ({ loaded }) => ({
      model: modifyFields(model, {
        load: () => LoadState.Loaded(),
        maybeOutline: () => Option.some(loaded.outline),
        maybeTemplate: () => Option.some(loaded.template),
        sectionId: () => loaded.sectionId,
        maybeSection: () => loaded.maybeSection,
        comments: () => loaded.comments,
        zone: () => loaded.zone,
      }),
    }),
    FailedLoadReview: ({ failure }) => ({
      model: modifyFields(model, { load: () => LoadState.Failed({ failure }) }),
    }),
    ClickedRetryLoad: () => ({
      model: modifyFields(model, { load: () => LoadState.Loading() }),
      commands: [
        LoadReview({ scope: pageScopeOf(model), revision: model.revision }),
      ],
    }),
    SelectedSection: ({ sectionId }) => ({
      model: modifyFields(model, {
        sectionId: () => sectionId,
        isSectionLoading: () => true,
        maybeSelection: () => Option.none(),
        composer: () => Composer.Closed(),
        commentText: () => '',
        visibility: () => 'authors',
      }),
      commands: [
        LoadRevisionSection({
          scope: pageScopeOf(model),
          revision: model.revision,
          sectionId,
        }),
      ],
    }),
    SucceededLoadRevisionSection: ({ sectionId, content }) =>
      sectionId === model.sectionId
        ? {
            model: modifyFields(model, {
              maybeSection: () => Option.some(content),
              isSectionLoading: () => false,
            }),
          }
        : { model },
    FailedLoadRevisionSection: ({ failure }) => ({
      model: modifyFields(failedWith(model, failure), {
        isSectionLoading: () => false,
      }),
    }),
    ChangedSelection: ({ maybeSelection }) => ({
      model: modifyFields(model, { maybeSelection: () => maybeSelection }),
    }),
    ClickedCommentOnText: () =>
      Option.match(model.maybeSelection, {
        onNone: () => ({ model }),
        onSome: selection => ({
          model: modifyFields(model, {
            composer: () => Composer.OnText({ selection }),
            commentText: () => '',
            visibility: () => 'authors',
            maybeNotice: () => Option.none(),
          }),
          commands: [FocusComposer()],
        }),
      }),
    ClickedCommentOnSection: () => ({
      model: modifyFields(model, {
        composer: () => Composer.OnSection({ sectionId: model.sectionId }),
        commentText: () => '',
        visibility: () => 'authors',
        maybeNotice: () => Option.none(),
      }),
      commands: [FocusComposer()],
    }),
    TypedComment: ({ text }) => ({
      model: modifyFields(model, { commentText: () => text }),
    }),
    ChoseVisibility: ({ visibility }) => ({
      model: modifyFields(model, { visibility: () => visibility }),
    }),
    CancelledComment: () => ({ model: composerClosed(model) }),
    CompletedFocusComposer: () => ({ model }),
    SubmittedComment: () =>
      Composer.guards.Closed(model.composer) ||
      model.commentText.trim() === '' ||
      model.isSending
        ? { model }
        : {
            model: modifyFields(model, {
              isSending: () => true,
              maybeNotice: () => Option.none(),
            }),
            commands: [
              AddReviewComment({
                scope: pageScopeOf(model),
                revision: model.revision,
                composer: model.composer,
                body: model.commentText.trim(),
                visibility: model.visibility,
              }),
            ],
          },
    SucceededAddComment: ({ comment }) => ({
      model: modifyFields(composerClosed(model), {
        isSending: () => false,
        comments: comments => [...comments, comment],
      }),
    }),
    FailedAddComment: ({ failure }) => ({ model: failedWith(model, failure) }),
    ClickedEditComment: ({ commentId }) => ({
      model: modifyFields(model, {
        maybeEditing: () =>
          Option.map(
            Array.findFirst(
              pendingComments(model),
              comment => comment.id === commentId,
            ),
            comment => ({
              commentId,
              text: comment.body,
              visibility: comment.visibility,
            }),
          ),
        maybeNotice: () => Option.none(),
      }),
    }),
    TypedEdit: ({ text }) => ({
      model: modifyFields(model, {
        maybeEditing: editing =>
          Option.map(editing, current => ({ ...current, text })),
      }),
    }),
    ChoseEditVisibility: ({ visibility }) => ({
      model: modifyFields(model, {
        maybeEditing: editing =>
          Option.map(editing, current => ({ ...current, visibility })),
      }),
    }),
    CancelledEdit: () => ({
      model: modifyFields(model, { maybeEditing: () => Option.none() }),
    }),
    SubmittedEdit: () =>
      Option.match(model.maybeEditing, {
        onNone: () => ({ model }),
        onSome: editing =>
          editing.text.trim() === '' || model.isSending
            ? { model }
            : {
                model: modifyFields(model, {
                  isSending: () => true,
                  maybeNotice: () => Option.none(),
                }),
                commands: [
                  UpdateReviewComment({
                    scope: pageScopeOf(model),
                    commentId: editing.commentId,
                    body: editing.text.trim(),
                    visibility: editing.visibility,
                  }),
                ],
              },
      }),
    SucceededUpdateComment: ({ comment }) => ({
      model: modifyFields(replaceComment(model, comment), {
        isSending: () => false,
        maybeEditing: () => Option.none(),
      }),
    }),
    FailedUpdateComment: ({ failure }) => ({
      model: failedWith(model, failure),
    }),
    ClickedDeleteComment: ({ commentId }) => ({
      model: modifyFields(model, { maybeNotice: () => Option.none() }),
      commands: [
        DeleteReviewComment({ scope: pageScopeOf(model), commentId }),
      ],
    }),
    SucceededDeleteComment: ({ commentId }) => ({
      model: modifyFields(model, {
        comments: comments =>
          Array.filter(comments, comment => comment.id !== commentId),
        maybeEditing: editing =>
          Option.filter(editing, current => current.commentId !== commentId),
      }),
    }),
    FailedDeleteComment: ({ failure }) => ({
      model: failedWith(model, failure),
    }),
    ClickedSendReview: () => ({
      model: modifyFields(model, {
        dialog: () => Dialog.Choosing({ maybeDecision: Option.none() }),
        maybeNotice: () => Option.none(),
        maybeSent: () => Option.none(),
      }),
    }),
    ChoseDecision: ({ decision }) =>
      Dialog.guards.Choosing(model.dialog)
        ? {
            model: modifyFields(model, {
              dialog: () =>
                Dialog.Choosing({ maybeDecision: Option.some(decision) }),
            }),
          }
        : { model },
    ClickedCancelSend: () =>
      Dialog.guards.Sending(model.dialog)
        ? { model }
        : { model: modifyFields(model, { dialog: () => Dialog.Closed() }) },
    ClickedConfirmSend: () =>
      Dialog.match<Update.Return<Model, Message>>(model.dialog, {
        Closed: () => ({ model }),
        Sending: () => ({ model }),
        Choosing: ({ maybeDecision }) =>
          Option.match(maybeDecision, {
            onNone: () => ({ model }),
            onSome: decision => ({
              model: modifyFields(model, {
                dialog: () => Dialog.Sending({ decision }),
              }),
              commands: [
                SendReview({
                  scope: pageScopeOf(model),
                  revision: model.revision,
                  decision,
                }),
              ],
            }),
          }),
      }),
    SucceededSendReview: ({ result }) => ({
      model: modifyFields(model, {
        dialog: () => Dialog.Closed(),
        maybeSent: () => Option.some(result),
        maybeEditing: () => Option.none(),
      }),
      commands: [
        RefreshReview({ scope: pageScopeOf(model), revision: model.revision }),
      ],
    }),
    FailedSendReview: ({ failure }) => ({
      model: modifyFields(failedWith(model, failure), {
        dialog: () => Dialog.Closed(),
      }),
    }),
    SucceededRefreshReview: ({ outline, comments }) => ({
      model: modifyFields(model, {
        maybeOutline: () => Option.some(outline),
        comments: () => comments,
      }),
    }),
    FailedRefreshReview: ({ failure }) => ({
      model: failedWith(model, failure),
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
  // NOTE: The text the reader selects, so it can be commented on. Only while
  // the round accepts comments.
  readingSelection: entry(
    { isOpen: Schema.Boolean },
    {
      modelToDependencies: model => ({ isOpen: mayComment(model) }),
      dependenciesToStream: ({ isOpen }) =>
        Dom.streamFromEventFilterMap({
          target: document,
          type: 'selectionchange',
          filterMapEvent: () =>
            Option.map(readCommentSelection(), maybeSelection =>
              Message.ChangedSelection({ maybeSelection }),
            ),
        }).pipe(Stream.when(Effect.sync(() => isOpen))),
    },
  ),
}))

// VIEW

const link = (h: HtmlBuilder<Message>, href: string, label: string): Html =>
  h.a(
    [h.Href(href), h.Class(clsx('text-lg text-msf-ink underline', focusRing))],
    [label],
  )

const shell = (
  h: HtmlBuilder<Message>,
  title: string,
  children: ReadonlyArray<Html>,
): Html =>
  h.section(
    [
      h.AriaLabel(title),
      h.Class('flex flex-col gap-6 pb-28 pt-10 md:pt-14'),
    ],
    [
      h.a(
        [
          h.Href(pathOf(AppRoute.Inbox())),
          h.Class(
            clsx('self-start text-base text-msf-ink underline', focusRing),
          ),
        ],
        ['Back to the inbox'],
      ),
      h.h1(
        [
          h.Id('page-heading'),
          h.Class(
            'text-balance text-4xl font-black tracking-[-0.025em] text-msf-black',
          ),
        ],
        [title],
      ),
      ...children,
    ],
  )

const VISIBILITY_LABEL = {
  authors: 'Authors only',
  committee: 'The whole committee',
} as const

const visibilityChoice = (
  h: HtmlBuilder<Message>,
  idPrefix: string,
  current: 'authors' | 'committee',
  choose: (visibility: 'authors' | 'committee') => Message,
): Html =>
  h.fieldset(
    [h.Class('flex flex-col gap-2')],
    [
      h.legend([h.Class('text-base font-medium text-msf-ink')], ['Visible to']),
      ...Array.map(
        [
          {
            value: 'authors' as const,
            label: 'Authors only (default)',
            hint: 'Only the authors of the report read this comment.',
          },
          {
            value: 'committee' as const,
            label: 'The whole committee',
            hint: 'The other reviewers of this revision read it too, with your name, once you send your review. You cannot change this afterwards.',
          },
        ],
        choice =>
          h.label(
            [
              h.Class('flex cursor-pointer items-start gap-3 text-base'),
              h.For(`${idPrefix}-${choice.value}`),
            ],
            [
              h.input([
                h.Id(`${idPrefix}-${choice.value}`),
                h.Type('radio'),
                h.Name(`${idPrefix}-visibility`),
                h.Class('mt-1 size-5 shrink-0 accent-msf-red'),
                h.Checked(current === choice.value),
                h.OnClick(choose(choice.value)),
              ]),
              h.span(
                [h.Class('flex flex-col')],
                [
                  h.span([h.Class('font-medium text-msf-ink')], [choice.label]),
                  h.span([h.Class('text-sm text-msf-grey')], [choice.hint]),
                ],
              ),
            ],
          ),
      ),
    ],
  )

const composerView = (
  h: HtmlBuilder<Message>,
  model: Model,
  template: Template,
): Html => {
  const target = Composer.match(model.composer, {
    Closed: () => Option.none<string>(),
    OnSection: ({ sectionId }) =>
      Option.some(
        `Comment on the section ${Option.match(
          findSection(topLevelSections(template), sectionId),
          { onNone: () => sectionId, onSome: found => found.title },
        )}`,
      ),
    OnText: ({ selection }) => Option.some(`Comment on: "${selection.quoted}"`),
  })
  return Option.match(target, {
    onNone: () => h.empty,
    onSome: heading =>
      h.form(
        [
          h.Class('flex flex-col gap-3 border-2 border-msf-ink px-3 py-3'),
          h.AriaLabel('New comment'),
          h.OnSubmit(Message.SubmittedComment()),
        ],
        [
          h.p([h.Class('text-base font-medium text-msf-ink')], [heading]),
          h.label(
            [
              h.Class('text-base font-medium text-msf-ink'),
              h.For('new-comment'),
            ],
            ['Your comment'],
          ),
          h.textarea([
            h.Id('new-comment'),
            h.Value(model.commentText),
            h.Class(
              clsx(
                'min-h-24 w-full border border-msf-line bg-white px-3 py-2 text-lg',
                focusRing,
              ),
            ),
            h.OnInput(text => Message.TypedComment({ text })),
          ]),
          visibilityChoice(h, 'new', model.visibility, visibility =>
            Message.ChoseVisibility({ visibility }),
          ),
          h.p(
            [h.Class('text-sm text-msf-grey')],
            ['It stays in your pending review until you send the review.'],
          ),
          h.div(
            [h.Class('flex flex-wrap gap-2')],
            [
              h.button(
                [
                  h.Type('submit'),
                  h.Disabled(
                    model.isSending || model.commentText.trim() === '',
                  ),
                  h.Class(
                    clsx(
                      'inline-flex min-h-11 cursor-pointer items-center justify-center bg-msf-ink px-4 text-base font-medium text-white disabled:opacity-60',
                      focusRing,
                    ),
                  ),
                ],
                [model.isSending ? 'Adding…' : 'Add comment'],
              ),
              actionButton(
                h,
                'Cancel',
                'Cancel the comment',
                Message.CancelledComment(),
              ),
            ],
          ),
        ],
      ),
  })
}

const locationText = (
  template: Template,
  comment: ReviewerCommentView,
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

const editView = (
  h: HtmlBuilder<Message>,
  model: Model,
  editing: typeof Editing.Type,
): Html =>
  h.form(
    [
      h.Class('flex flex-col gap-3 border-2 border-msf-ink px-3 py-3'),
      h.AriaLabel('Edit comment'),
      h.OnSubmit(Message.SubmittedEdit()),
    ],
    [
      h.label(
        [
          h.Class('text-base font-medium text-msf-ink'),
          h.For(`edit-${editing.commentId}`),
        ],
        ['Edit your comment'],
      ),
      h.textarea([
        h.Id(`edit-${editing.commentId}`),
        h.Value(editing.text),
        h.Class(
          clsx(
            'min-h-24 w-full border border-msf-line bg-white px-3 py-2 text-lg',
            focusRing,
          ),
        ),
        h.OnInput(text => Message.TypedEdit({ text })),
      ]),
      visibilityChoice(
        h,
        `edit-${editing.commentId}`,
        editing.visibility,
        visibility => Message.ChoseEditVisibility({ visibility }),
      ),
      h.div(
        [h.Class('flex flex-wrap gap-2')],
        [
          h.button(
            [
              h.Type('submit'),
              h.Disabled(model.isSending || editing.text.trim() === ''),
              h.Class(
                clsx(
                  'inline-flex min-h-11 cursor-pointer items-center justify-center bg-msf-ink px-4 text-base font-medium text-white disabled:opacity-60',
                  focusRing,
                ),
              ),
            ],
            ['Save changes'],
          ),
          actionButton(
            h,
            'Cancel',
            'Cancel the changes',
            Message.CancelledEdit(),
          ),
        ],
      ),
    ],
  )

const snippet = (text: string): string =>
  text.length > 40 ? `${text.slice(0, 40)}…` : text

const commentCard = (
  h: HtmlBuilder<Message>,
  model: Model,
  template: Template,
  comment: ReviewerCommentView,
): Html => {
  const isPending = comment.mine && !comment.sent
  const maybeEditing = Option.filter(
    model.maybeEditing,
    editing => editing.commentId === comment.id,
  )
  return h.keyed('li')(
    comment.id,
    [
      h.Class(
        clsx('flex flex-col gap-3 py-4', comment.resolved && 'text-msf-grey'),
      ),
      h.DataAttribute('comment', comment.id),
      h.DataAttribute('visibility', comment.visibility),
      h.DataAttribute('sent', comment.sent ? 'true' : 'false'),
      h.DataAttribute('resolved', comment.resolved ? 'true' : 'false'),
    ],
    [
      h.p(
        [h.Class('text-base text-msf-grey')],
        [
          `${comment.mine ? 'You' : comment.authorName}, ${momentText(comment.createdAt)}, on ${locationText(template, comment)}`,
          comment.resolved ? ' · Resolved by the authors' : '',
        ],
      ),
      h.p(
        [h.Class('text-sm font-medium text-msf-ink')],
        [
          `${VISIBILITY_LABEL[comment.visibility]}${comment.mine ? (comment.sent ? ' · Sent' : ' · Not sent yet') : ''}`,
        ],
      ),
      comment.anchor.kind === 'text'
        ? h.blockquote(
            [
              h.Class(
                'border-l-4 border-sky-700 pl-3 text-lg italic text-msf-ink',
              ),
            ],
            [comment.anchor.quoted],
          )
        : comment.anchor.kind === 'section_note' &&
            comment.anchor.quoted !== undefined
          ? h.blockquote(
              [
                h.Class(
                  'border-l-4 border-msf-line pl-3 text-lg italic text-msf-ink',
                ),
              ],
              [comment.anchor.quoted],
            )
          : h.empty,
      Option.match(maybeEditing, {
        onSome: editing => editView(h, model, editing),
        onNone: () =>
          h.p(
            [h.Class('whitespace-pre-wrap text-lg text-msf-ink')],
            [comment.body],
          ),
      }),
      ...Array.map(comment.replies, reply =>
        h.keyed('div')(
          reply.id,
          [
            h.Class('ml-4 flex flex-col gap-1 border-l-2 border-msf-line pl-3'),
            h.DataAttribute('reply', reply.id),
          ],
          [
            h.p(
              [h.Class('text-sm text-msf-grey')],
              [`Reply from ${reply.authorName}, ${momentText(reply.createdAt)}`],
            ),
            h.p(
              [h.Class('whitespace-pre-wrap text-lg text-msf-ink')],
              [reply.body],
            ),
          ],
        ),
      ),
      isPending && Option.isNone(maybeEditing) && isRoundOpen(model)
        ? h.div(
            [h.Class('flex flex-wrap gap-2')],
            [
              actionButton(
                h,
                'Edit',
                `Edit comment: ${snippet(comment.body)}`,
                Message.ClickedEditComment({ commentId: comment.id }),
              ),
              actionButton(
                h,
                'Delete',
                `Delete comment: ${snippet(comment.body)}`,
                Message.ClickedDeleteComment({ commentId: comment.id }),
              ),
            ],
          )
        : h.empty,
    ],
  )
}

const commentsPanel = (
  h: HtmlBuilder<Message>,
  model: Model,
  template: Template,
  sectionTitle: string,
): Html => {
  const comments = commentsInSection(model, model.sectionId)
  return h.aside(
    [
      h.AriaLabel('Comments'),
      h.DataAttribute('comments-panel', 'true'),
      h.Class('flex min-w-0 flex-col gap-4'),
    ],
    [
      h.h2([h.Class('text-2xl font-black text-msf-black')], ['Comments']),
      mayComment(model)
        ? h.div(
            [h.Class('flex flex-col gap-3')],
            [
              h.div(
                [h.Class('flex flex-wrap gap-2')],
                [
                  actionButton(
                    h,
                    'Comment on this section',
                    'Comment on this section',
                    Message.ClickedCommentOnSection(),
                  ),
                ],
              ),
              Composer.guards.Closed(model.composer)
                ? h.p(
                    [h.Class('text-base text-msf-grey')],
                    [
                      `Select some text to comment on it, or comment on ${sectionTitle} as a whole.`,
                    ],
                  )
                : h.empty,
              composerView(h, model, template),
            ],
          )
        : h.empty,
      Option.match(model.maybeNotice, {
        onNone: () => h.empty,
        onSome: notice => alertText(h, notice),
      }),
      Array.match(comments, {
        onEmpty: () =>
          h.p([h.Class('text-lg text-msf-grey')], ['No comments here yet.']),
        onNonEmpty: list =>
          h.ul(
            [
              h.AriaLabel(`Comments on ${sectionTitle}`),
              h.Class(
                'flex flex-col divide-y divide-msf-line border-y border-msf-line',
              ),
            ],
            Array.map(list, comment =>
              commentCard(h, model, template, comment),
            ),
          ),
      }),
    ],
  )
}

const selectionBar = (h: HtmlBuilder<Message>, model: Model): Html =>
  Option.match(model.maybeSelection, {
    onNone: () => h.empty,
    onSome: selection =>
      mayComment(model) && Composer.guards.Closed(model.composer)
        ? h.div(
            [
              h.DataAttribute('selection-bar', 'true'),
              h.Class(
                'fixed inset-x-0 bottom-0 z-20 flex flex-wrap items-center gap-3 border-t-2 border-msf-ink bg-white px-5 py-3 sm:px-10',
              ),
            ],
            [
              h.p(
                [
                  h.Class('min-w-0 flex-1 truncate text-base text-msf-ink'),
                  h.DataAttribute('selected', 'true'),
                ],
                [`Selected: "${snippet(selection.quoted)}"`],
              ),
              h.button(
                [
                  h.Type('button'),
                  h.Class(
                    clsx(
                      'inline-flex min-h-11 cursor-pointer items-center justify-center bg-msf-ink px-4 text-base font-medium text-white',
                      focusRing,
                    ),
                  ),
                  h.AriaLabel('Comment on the selected text'),
                  h.OnClick(Message.ClickedCommentOnText()),
                ],
                ['Comment'],
              ),
            ],
          )
        : h.empty,
  })

const decisionChoices: ReadonlyArray<
  Readonly<{
    value: typeof ReviewDecisionSchema.Type
    label: string
    hint: string
    needsVote: boolean
  }>
> = [
  {
    value: 'approve',
    label: 'Approve',
    hint: 'You agree with this revision as it is.',
    needsVote: true,
  },
  {
    value: 'request_changes',
    label: 'Request changes',
    hint: 'The authors are asked to change it. Your comments say what.',
    needsVote: true,
  },
  {
    value: 'comment',
    label: 'Comment only',
    hint: 'Your comments are sent. You neither approve nor ask for changes.',
    needsVote: false,
  },
]

const pendingLine = (
  template: Template,
  comment: ReviewerCommentView,
): string =>
  `${locationText(template, comment)}: "${snippet(comment.body)}" (${VISIBILITY_LABEL[comment.visibility].toLowerCase()})`

const sendDialog = (
  h: HtmlBuilder<Message>,
  model: Model,
  outline: typeof RevisionOutline.Type,
  template: Template,
): Html =>
  Dialog.match(model.dialog, {
    Closed: () => h.empty,
    Choosing: ({ maybeDecision }) =>
      sendDialogBody(h, model, outline, template, maybeDecision, false),
    Sending: ({ decision }) =>
      sendDialogBody(h, model, outline, template, Option.some(decision), true),
  })

const sendDialogBody = (
  h: HtmlBuilder<Message>,
  model: Model,
  outline: typeof RevisionOutline.Type,
  template: Template,
  maybeDecision: Option.Option<typeof ReviewDecisionSchema.Type>,
  isSending: boolean,
): Html => {
  const pending = pendingComments(model)
  const toAuthors = Array.filter(
    pending,
    comment => comment.visibility === 'authors',
  ).length
  const toCommittee = pending.length - toAuthors
  return h.section(
    [
      h.AriaLabel('Send your review'),
      h.Role('alertdialog'),
      h.DataAttribute('dialog', 'send-review'),
      h.Class(
        'flex max-w-3xl flex-col gap-4 border-2 border-msf-ink bg-white px-4 py-4',
      ),
    ],
    [
      h.h2(
        [h.Class('text-2xl font-black text-msf-black')],
        ['Send your review'],
      ),
      Array.match(pending, {
        onEmpty: () =>
          h.p(
            [h.Class('text-lg text-msf-ink')],
            ['You have no comments waiting. Only your decision is sent.'],
          ),
        onNonEmpty: list =>
          h.div(
            [h.Class('flex flex-col gap-2')],
            [
              h.p(
                [h.Class('text-lg font-medium text-msf-ink')],
                [
                  `${list.length} ${list.length === 1 ? 'comment is' : 'comments are'} sent: ${toAuthors} to the authors only, ${toCommittee} to the whole committee.`,
                ],
              ),
              h.ul(
                [
                  h.AriaLabel('Comments in this review'),
                  h.Class('flex list-disc flex-col gap-1 pl-6 text-base'),
                ],
                Array.map(list, comment =>
                  h.keyed('li')(comment.id, [], [pendingLine(template, comment)]),
                ),
              ),
            ],
          ),
      }),
      h.fieldset(
        [h.Class('flex flex-col gap-2')],
        [
          h.legend(
            [h.Class('text-base font-medium text-msf-ink')],
            ['Your decision'],
          ),
          ...Array.map(
            Array.filter(
              decisionChoices,
              choice => outline.canVote || !choice.needsVote,
            ),
            choice =>
              h.label(
                [
                  h.Class('flex cursor-pointer items-start gap-3 text-base'),
                  h.For(`decision-${choice.value}`),
                ],
                [
                  h.input([
                    h.Id(`decision-${choice.value}`),
                    h.Type('radio'),
                    h.Name('decision'),
                    h.Class('mt-1 size-5 shrink-0 accent-msf-red'),
                    h.Checked(
                      Option.exists(
                        maybeDecision,
                        decision => decision === choice.value,
                      ),
                    ),
                    h.Disabled(isSending),
                    h.OnClick(Message.ChoseDecision({ decision: choice.value })),
                  ]),
                  h.span(
                    [h.Class('flex flex-col')],
                    [
                      h.span(
                        [h.Class('font-medium text-msf-ink')],
                        [choice.label],
                      ),
                      h.span(
                        [h.Class('text-sm text-msf-grey')],
                        [choice.hint],
                      ),
                    ],
                  ),
                ],
              ),
          ),
        ],
      ),
      h.p(
        [h.Class('text-base text-msf-ink')],
        [
          'Once the review is sent you can no longer change these comments or who sees them.',
        ],
      ),
      h.div(
        [h.Class('flex flex-wrap gap-2')],
        [
          h.button(
            [
              h.Type('button'),
              h.Disabled(Option.isNone(maybeDecision) || isSending),
              h.Class(
                clsx(
                  'inline-flex min-h-11 cursor-pointer items-center justify-center bg-msf-red px-4 text-base font-medium text-white disabled:opacity-60',
                  focusRing,
                ),
              ),
              h.OnClick(Message.ClickedConfirmSend()),
            ],
            [isSending ? 'Sending…' : 'Confirm and send review'],
          ),
          actionButton(
            h,
            'Cancel',
            'Cancel, do not send',
            Message.ClickedCancelSend(),
            isSending,
          ),
        ],
      ),
    ],
  )
}

const pendingPanel = (
  h: HtmlBuilder<Message>,
  model: Model,
  outline: typeof RevisionOutline.Type,
  template: Template,
): Html => {
  const pending = pendingComments(model)
  return panel(
    h,
    'Your review',
    [
      Option.match(model.maybeSent, {
        onNone: () => h.empty,
        onSome: result =>
          h.p(
            [
              h.Role('status'),
              h.DataAttribute('review-sent', result.decision),
              h.Class('text-lg font-medium text-msf-ink'),
            ],
            [
              `Your review was sent: ${decisionText(result.decision)}, with ${result.commentsSent} ${result.commentsSent === 1 ? 'comment' : 'comments'}.`,
            ],
          ),
      }),
      outline.myDecision === undefined || Option.isSome(model.maybeSent)
        ? h.empty
        : h.p(
            [h.Class('text-lg text-msf-ink')],
            [`Your last review: ${decisionText(outline.myDecision)}.`],
          ),
      Array.match(pending, {
        onEmpty: () =>
          h.p(
            [h.Class('text-lg text-msf-grey')],
            ['No comments are waiting to be sent.'],
          ),
        onNonEmpty: list =>
          h.div(
            [h.Class('flex flex-col gap-2')],
            [
              h.p(
                [
                  h.DataAttribute('pending-count', String(list.length)),
                  h.Class('text-lg font-medium text-msf-ink'),
                ],
                [
                  `${list.length} ${list.length === 1 ? 'comment is' : 'comments are'} waiting to be sent. They are kept for you until you send the review.`,
                ],
              ),
              h.ul(
                [
                  h.AriaLabel('Comments waiting to be sent'),
                  h.Class('flex list-disc flex-col gap-1 pl-6 text-base'),
                ],
                Array.map(list, comment =>
                  h.keyed('li')(comment.id, [], [pendingLine(template, comment)]),
                ),
              ),
            ],
          ),
      }),
      mayComment(model) && Dialog.guards.Closed(model.dialog)
        ? h.button(
            [
              h.Type('button'),
              h.Class(
                clsx(
                  'inline-flex min-h-12 cursor-pointer items-center justify-center self-start bg-msf-red px-6 text-lg font-medium text-white',
                  focusRing,
                ),
              ),
              h.AriaLabel('Send your review'),
              h.OnClick(Message.ClickedSendReview()),
            ],
            ['Send review…'],
          )
        : h.empty,
      sendDialog(h, model, outline, template),
    ],
    Option.some(
      'Comments are sent together as one review: approve, request changes, or comment only.',
    ),
  )
}

const banner = (
  h: HtmlBuilder<Message>,
  model: Model,
  outline: typeof RevisionOutline.Type,
): Html => {
  const deadline = `Due ${deadlineText(outline.round.deadline.at, model.zone)}${zoneNote(outline.round.deadline.timeZone, model.zone)}.`
  return outline.round.status === 'superseded'
    ? h.div(
        [
          h.Role('status'),
          h.DataAttribute('banner', 'superseded'),
          h.Class(
            'flex flex-col gap-2 border-2 border-msf-ink bg-msf-mist px-4 py-3',
          ),
        ],
        [
          h.p(
            [h.Class('text-lg font-medium text-msf-ink')],
            [
              `This revision was replaced by Revision ${model.revision + 1}. It is read-only and takes no more reviews.`,
            ],
          ),
          link(
            h,
            pathOf(
              AppRoute.Revision({
                reportId: model.reportId,
                revision: model.revision + 1,
              }),
            ),
            `Read Revision ${model.revision + 1}`,
          ),
        ],
      )
    : outline.round.status === 'decided'
      ? h.div(
          [
            h.Role('status'),
            h.DataAttribute('banner', 'decided'),
            h.Class(
              'flex flex-col gap-2 border-2 border-msf-ink bg-msf-mist px-4 py-3',
            ),
          ],
          [
            h.p(
              [h.Class('text-lg font-medium text-msf-ink')],
              [
                outline.round.decidedBy === 'deadline'
                  ? 'This round was decided at its deadline. It is read-only and takes no more reviews.'
                  : 'This round is decided. It is read-only and takes no more reviews.',
              ],
            ),
          ],
        )
      : h.p([h.Class('text-base text-msf-ink')], [deadline])
}

const sectionNav = (
  h: HtmlBuilder<Message>,
  model: Model,
  template: Template,
  outline: typeof RevisionOutline.Type,
): Html => {
  const sections = Array.filter(topLevelSections(template), section =>
    Array.some(outline.sections, ref => ref.sectionId === section.id),
  )
  return h.nav(
    [h.AriaLabel('Sections'), h.Class('flex flex-wrap gap-2')],
    Array.map(sections, section => {
      const count = commentsInSection(model, section.id).length
      return h.keyed('button')(
        section.id,
        [
          h.Type('button'),
          ...(section.id === model.sectionId ? [h.AriaCurrent('true')] : []),
          h.Class(
            clsx(
              'min-h-11 cursor-pointer border px-3 text-base',
              section.id === model.sectionId
                ? 'border-msf-ink bg-msf-ink text-white'
                : 'border-msf-line text-msf-ink hover:border-msf-red',
              focusRing,
            ),
          ),
          h.OnClick(Message.SelectedSection({ sectionId: section.id })),
        ],
        [count === 0 ? section.title : `${section.title} (${count})`],
      )
    }),
  )
}

const readingView = (
  h: HtmlBuilder<Message>,
  model: Model,
  template: Template,
  outline: typeof RevisionOutline.Type,
): Html => {
  const current = findSection(topLevelSections(template), model.sectionId)
  return shell(h, outline.label, [
    h.p(
      [h.Class('text-base text-msf-grey')],
      [`${outline.caseReference} · ${outline.caseTitle}`],
    ),
    banner(h, model, outline),
    sectionNav(h, model, template, outline),
    h.div(
      [
        h.DataAttribute('reading', 'true'),
        h.Class('grid gap-8 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]'),
      ],
      [
        model.isSectionLoading
          ? loadingText(h, 'Loading the section.')
          : Option.match(current, {
              onNone: () =>
                statusText(h, 'There is nothing to read in this revision.'),
              onSome: section =>
                h.article(
                  [
                    h.AriaLabel(section.title),
                    h.DataAttribute('revision-section', section.id),
                    h.Class('flex min-w-0 flex-col gap-4'),
                  ],
                  [
                    h.h2(
                      [h.Class('text-2xl font-black text-msf-black')],
                      [section.title],
                    ),
                    readOnlySection(
                      h,
                      section,
                      Option.getOrUndefined(model.maybeSection),
                      {
                        reportId: model.reportId,
                        people: [],
                        peopleHidden: true,
                        topSectionId: section.id,
                        imageContext: imageContextToken({
                          kind: 'revision',
                          revision: model.revision,
                        }),
                        highlights: highlightsOf(model, section.id),
                      },
                    ),
                  ],
                ),
            }),
        commentsPanel(
          h,
          model,
          template,
          Option.match(current, {
            onNone: () => 'this section',
            onSome: section => section.title,
          }),
        ),
      ],
    ),
    pendingPanel(h, model, outline, template),
    selectionBar(h, model),
  ])
}

export const view = Submodel.defineView<Model, Message>((model, h) =>
  LoadState.match(model.load, {
    Loading: () =>
      shell(h, `Revision ${model.revision}`, [loadingText(h, 'Loading.')]),
    Failed: ({ failure }) =>
      shell(h, `Revision ${model.revision}`, [
        failure._tag === 'NotAllowed'
          ? alertText(h, 'This revision is not available to you.')
          : alertText(h, failureText(failure)),
        actionButton(h, 'Try again', 'Try again', Message.ClickedRetryLoad()),
      ]),
    Loaded: () =>
      Option.match(
        Option.all({
          template: model.maybeTemplate,
          outline: model.maybeOutline,
        }),
        {
          onNone: () =>
            shell(h, `Revision ${model.revision}`, [
              loadingText(h, 'Loading.'),
            ]),
          onSome: ({ template, outline }) =>
            readingView(h, model, template, outline),
        },
      ),
  }),
)
