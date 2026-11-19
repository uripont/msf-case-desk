import { clsx } from 'clsx'
import { Array, Effect, Option, Record, Schema, Stream } from 'effect'
import { Command, Dom, Submodel, Subscription, Update } from 'foldkit'
import { Html, HtmlBuilder } from 'foldkit/html'
import { defineMessageUnion } from 'foldkit/message'
import { defineTaggedUnion } from 'foldkit/schema'
import { modifyFields } from 'foldkit/struct'

import {
  AuthorCommentView,
  DraftComparison,
  DraftOutline,
  History,
  PeopleList,
  ReportDetail,
  SectionContent,
  Template,
  draftLabel,
} from '@quoroom/domain'

import { AppRoute, pathOf } from '../route'
import { focusRing } from '../style'
import { withQuoroom } from './api'
import { readOnlySection } from './contentView'
import {
  findItem,
  findSection,
  momentText,
  topLevelSections,
} from './draftText'
import { actionButton } from './entryViews'
import { Failure, failureOf, failureText } from './failure'
import { imageContextToken } from './images/spec'
import { statusText as revisionStatusText } from './rounds'
import { PageScope, isCurrentPage, pageScopeOf } from './scope'
import { CommentSelection, readCommentSelection } from './selection'
import { alertText, loadingText, panel, statusText } from './ui'
import { LoadState } from './unit'

// NOTE: Draft history: the list of shared drafts with who shared
// them and when, a read-only view of any one (no editor; the rich text is
// drawn by `richTextView`), the comparison of two drafts, and the comments the
// authors leave on a draft for each other. Comments on a draft are never
// shown to a reviewer: the server answers a reviewer as if the draft did not
// exist. Text is commented on by selecting it in the read-only view, which
// reports the selection as an anchor (`selection.ts`); a whole section can be
// commented on without a selection.

export const Composer = defineTaggedUnion({
  Closed: {},
  OnText: { selection: CommentSelection },
  OnSection: { sectionId: Schema.String },
})
export type Composer = typeof Composer.Type

export const ViewState = Schema.Struct({
  outline: DraftOutline,
  people: PeopleList,
  comments: Schema.Array(AuthorCommentView),
})

export const Model = Schema.Struct({
  origin: Schema.String,
  reportId: Schema.String,
  generation: Schema.Int,
  maybeDraft: Schema.Option(Schema.Int),
  load: LoadState,
  maybeDetail: Schema.Option(ReportDetail),
  maybeTemplate: Schema.Option(Template),
  maybeHistory: Schema.Option(History),
  maybeView: Schema.Option(ViewState),
  sectionId: Schema.String,
  maybeSection: Schema.Option(SectionContent),
  isSectionLoading: Schema.Boolean,
  maybeSelection: Schema.Option(CommentSelection),
  composer: Composer,
  commentText: Schema.String,
  isSending: Schema.Boolean,
  replyTexts: Schema.Record(Schema.String, Schema.String),
  maybeNotice: Schema.Option(Schema.String),
  compareFrom: Schema.String,
  compareTo: Schema.String,
  maybeComparison: Schema.Option(DraftComparison),
  isComparing: Schema.Boolean,
})
export type Model = typeof Model.Type

export const initialModel = Model.make({
  origin: '',
  reportId: '',
  generation: 0,
  maybeDraft: Option.none(),
  load: LoadState.Loading(),
  maybeDetail: Option.none(),
  maybeTemplate: Option.none(),
  maybeHistory: Option.none(),
  maybeView: Option.none(),
  sectionId: '',
  maybeSection: Option.none(),
  isSectionLoading: false,
  maybeSelection: Option.none(),
  composer: Composer.Closed(),
  commentText: '',
  isSending: false,
  replyTexts: {},
  maybeNotice: Option.none(),
  compareFrom: '',
  compareTo: '',
  maybeComparison: Option.none(),
  isComparing: false,
})

export const LoadedHistory = Schema.Struct({
  detail: ReportDetail,
  template: Template,
  history: History,
  maybeView: Schema.Option(ViewState),
  sectionId: Schema.String,
  maybeSection: Schema.Option(SectionContent),
})
export type LoadedHistory = typeof LoadedHistory.Type

export const Message = defineMessageUnion({
  SucceededLoadHistory: { scope: PageScope, loaded: LoadedHistory },
  FailedLoadHistory: { scope: PageScope, failure: Failure },
  ClickedRetryLoad: {},
  SelectedSection: { sectionId: Schema.String },
  SucceededLoadDraftSection: {
    scope: PageScope,
    sectionId: Schema.String,
    content: SectionContent,
  },
  FailedLoadDraftSection: { scope: PageScope, failure: Failure },
  ChangedSelection: { maybeSelection: Schema.Option(CommentSelection) },
  ClickedCommentOnText: {},
  ClickedCommentOnSection: {},
  TypedComment: { text: Schema.String },
  SubmittedComment: {},
  CancelledComment: {},
  SucceededAddComment: { scope: PageScope, comment: AuthorCommentView },
  FailedAddComment: { scope: PageScope, failure: Failure },
  TypedReply: { commentId: Schema.String, text: Schema.String },
  SubmittedReply: { commentId: Schema.String },
  SucceededReply: { scope: PageScope, comment: AuthorCommentView },
  FailedReply: { scope: PageScope, failure: Failure },
  ClickedResolve: { commentId: Schema.String, resolved: Schema.Boolean },
  SucceededResolve: { scope: PageScope, comment: AuthorCommentView },
  FailedResolve: { scope: PageScope, failure: Failure },
  SelectedCompareFrom: { value: Schema.String },
  SelectedCompareTo: { value: Schema.String },
  SubmittedCompare: {},
  SucceededCompare: { scope: PageScope, comparison: DraftComparison },
  FailedCompare: { scope: PageScope, failure: Failure },
})
export type Message = typeof Message.Type

// COMMAND

export const LoadHistory = Command.define('LoadHistory', {
  args: { scope: PageScope, maybeDraft: Schema.Option(Schema.Int) },
  messages: [Message.SucceededLoadHistory, Message.FailedLoadHistory],
  execute: ({ scope, scope: { reportId }, maybeDraft }) =>
    withQuoroom(client =>
      Effect.gen(function* () {
        const detail = yield* client.GetReport({ reportId })
        const version = yield* client.GetTemplateVersion({
          templateId: detail.summary.templateId,
          version: detail.summary.templateVersion,
          reportId,
        })
        const history = yield* client.GetHistory({ reportId })
        if (Option.isNone(maybeDraft)) {
          return {
            detail,
            template: version.template,
            history,
            maybeView: Option.none(),
            sectionId: '',
            maybeSection: Option.none(),
          }
        }
        const draft = maybeDraft.value
        const outline = yield* client.GetDraftOutline({ reportId, draft })
        const people = yield* client.GetPeople({ reportId, draft })
        const comments = yield* client
          .ListDraftComments({ reportId, draft })
          .pipe(Effect.catch(() => Effect.succeed([])))
        const sections = topLevelSections(version.template)
        const first = Array.findFirst(sections, section =>
          Array.some(outline.sections, ref => ref.sectionId === section.id),
        ).pipe(Option.orElse(() => Array.head(sections)))
        const sectionId = Option.match(first, {
          onNone: () => '',
          onSome: section => section.id,
        })
        const loaded =
          sectionId === ''
            ? Option.none()
            : Option.some(
                yield* client.GetDraftSection({
                  reportId,
                  draft,
                  sectionId,
                  view: 'original',
                }),
              )
        return {
          detail,
          template: version.template,
          history,
          maybeView: Option.some({
            outline,
            people: people.people,
            comments,
          }),
          sectionId,
          maybeSection: Option.map(loaded, section => section.content),
        }
      }),
    ).pipe(
      Effect.map(loaded => Message.SucceededLoadHistory({ scope, loaded })),
      Effect.catch(error =>
        Effect.succeed(
          Message.FailedLoadHistory({ scope, failure: failureOf(error) }),
        ),
      ),
    ),
})

export const LoadDraftSection = Command.define('LoadDraftSection', {
  args: {
    scope: PageScope,
    draft: Schema.Int,
    sectionId: Schema.String,
  },
  messages: [Message.SucceededLoadDraftSection, Message.FailedLoadDraftSection],
  execute: ({ scope, scope: { reportId }, draft, sectionId }) =>
    withQuoroom(client =>
      client.GetDraftSection({ reportId, draft, sectionId, view: 'original' }),
    ).pipe(
      Effect.map(section =>
        Message.SucceededLoadDraftSection({
          scope,
          sectionId,
          content: section.content,
        }),
      ),
      Effect.catch(error =>
        Effect.succeed(
          Message.FailedLoadDraftSection({ scope, failure: failureOf(error) }),
        ),
      ),
    ),
})

export const AddComment = Command.define('AddComment', {
  args: {
    scope: PageScope,
    draft: Schema.Int,
    composer: Composer,
    body: Schema.String,
  },
  messages: [Message.SucceededAddComment, Message.FailedAddComment],
  execute: ({ scope, scope: { reportId }, draft, composer, body }) =>
    withQuoroom(client =>
      client.AddDraftComment({
        reportId,
        draft,
        body,
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

export const ReplyTo = Command.define('ReplyTo', {
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

export const SetResolved = Command.define('SetResolved', {
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

export const CompareTwo = Command.define('CompareTwo', {
  args: { scope: PageScope, from: Schema.Int, to: Schema.Int },
  messages: [Message.SucceededCompare, Message.FailedCompare],
  execute: ({ scope, scope: { reportId }, from, to }) =>
    withQuoroom(client => client.CompareDrafts({ reportId, from, to })).pipe(
      Effect.map(comparison => Message.SucceededCompare({ scope, comparison })),
      Effect.catch(error =>
        Effect.succeed(
          Message.FailedCompare({ scope, failure: failureOf(error) }),
        ),
      ),
    ),
})

// QUERIES

export const mayComment = (model: Model): boolean =>
  Option.exists(model.maybeDetail, detail =>
    Array.contains(detail.permissions, 'comment_drafts'),
  )

// INIT

export const enter = (
  origin: string,
  reportId: string,
  generation: number,
  maybeDraft: Option.Option<number>,
): Update.Return<Model, Message> => {
  const fresh = modifyFields(initialModel, {
    origin: () => origin,
    reportId: () => reportId,
    generation: () => generation,
    maybeDraft: () => maybeDraft,
  })
  return {
    model: fresh,
    commands: [LoadHistory({ scope: pageScopeOf(fresh), maybeDraft })],
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
    maybeView: view =>
      Option.map(view, state => ({
        ...state,
        comments: Array.map(state.comments, existing =>
          existing.id === comment.id ? comment : existing,
        ),
      })),
  })

const failedWith = (model: Model, failure: Failure): Model =>
  modifyFields(model, {
    isSending: () => false,
    maybeNotice: () => Option.some(failureText(failure)),
  })

const updateCurrent = (model: Model, message: Message) =>
  Message.match<Update.Return<Model, Message>>(message, {
    SucceededLoadHistory: ({ loaded }) => ({
      model: modifyFields(model, {
        load: () => LoadState.Loaded(),
        maybeDetail: () => Option.some(loaded.detail),
        maybeTemplate: () => Option.some(loaded.template),
        maybeHistory: () => Option.some(loaded.history),
        maybeView: () => loaded.maybeView,
        sectionId: () => loaded.sectionId,
        maybeSection: () => loaded.maybeSection,
        compareFrom: () =>
          String(Math.max(0, loaded.history.drafts.length - 2)),
        compareTo: () => String(Math.max(0, loaded.history.drafts.length - 1)),
      }),
    }),
    FailedLoadHistory: ({ failure }) => ({
      model: modifyFields(model, { load: () => LoadState.Failed({ failure }) }),
    }),
    ClickedRetryLoad: () => ({
      model: modifyFields(model, { load: () => LoadState.Loading() }),
      commands: [
        LoadHistory({
          scope: pageScopeOf(model),
          maybeDraft: model.maybeDraft,
        }),
      ],
    }),
    SelectedSection: ({ sectionId }) =>
      Option.match(model.maybeDraft, {
        onNone: () => ({ model }),
        onSome: draft => ({
          model: modifyFields(model, {
            sectionId: () => sectionId,
            isSectionLoading: () => true,
            maybeSelection: () => Option.none(),
            composer: () => Composer.Closed(),
          }),
          commands: [
            LoadDraftSection({
              scope: pageScopeOf(model),
              draft,
              sectionId,
            }),
          ],
        }),
      }),
    SucceededLoadDraftSection: ({ sectionId, content }) =>
      sectionId === model.sectionId
        ? {
            model: modifyFields(model, {
              maybeSection: () => Option.some(content),
              isSectionLoading: () => false,
            }),
          }
        : { model },
    FailedLoadDraftSection: ({ failure }) => ({
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
            maybeNotice: () => Option.none(),
          }),
        }),
      }),
    ClickedCommentOnSection: () => ({
      model: modifyFields(model, {
        composer: () => Composer.OnSection({ sectionId: model.sectionId }),
        commentText: () => '',
        maybeNotice: () => Option.none(),
      }),
    }),
    TypedComment: ({ text }) => ({
      model: modifyFields(model, { commentText: () => text }),
    }),
    CancelledComment: () => ({
      model: modifyFields(model, {
        composer: () => Composer.Closed(),
        commentText: () => '',
      }),
    }),
    SubmittedComment: () =>
      Option.match(model.maybeDraft, {
        onNone: () => ({ model }),
        onSome: draft =>
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
                  AddComment({
                    scope: pageScopeOf(model),
                    draft,
                    composer: model.composer,
                    body: model.commentText.trim(),
                  }),
                ],
              },
      }),
    SucceededAddComment: ({ comment }) => ({
      model: modifyFields(model, {
        isSending: () => false,
        composer: () => Composer.Closed(),
        commentText: () => '',
        maybeSelection: () => Option.none(),
        maybeView: view =>
          Option.map(view, state => ({
            ...state,
            comments: [...state.comments, comment],
          })),
      }),
    }),
    FailedAddComment: ({ failure }) => ({ model: failedWith(model, failure) }),
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
            commands: [ReplyTo({ scope: pageScopeOf(model), commentId, body })],
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
        SetResolved({ scope: pageScopeOf(model), commentId, resolved }),
      ],
    }),
    SucceededResolve: ({ comment }) => ({
      model: replaceComment(model, comment),
    }),
    FailedResolve: ({ failure }) => ({ model: failedWith(model, failure) }),
    SelectedCompareFrom: ({ value }) => ({
      model: modifyFields(model, { compareFrom: () => value }),
    }),
    SelectedCompareTo: ({ value }) => ({
      model: modifyFields(model, { compareTo: () => value }),
    }),
    SubmittedCompare: () => {
      const from = Number.parseInt(model.compareFrom, 10)
      const to = Number.parseInt(model.compareTo, 10)
      return Number.isNaN(from) || Number.isNaN(to)
        ? { model }
        : {
            model: modifyFields(model, {
              isComparing: () => true,
              maybeNotice: () => Option.none(),
            }),
            commands: [CompareTwo({ scope: pageScopeOf(model), from, to })],
          }
    },
    SucceededCompare: ({ comparison }) => ({
      model: modifyFields(model, {
        isComparing: () => false,
        maybeComparison: () => Option.some(comparison),
      }),
    }),
    FailedCompare: ({ failure }) => ({
      model: modifyFields(failedWith(model, failure), {
        isComparing: () => false,
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

// SUBSCRIPTION

export const subscriptions = Subscription.make<Model, Message>()(entry => ({
  // NOTE: The text the reader selects in the draft being read, so a comment
  // can be made on it. Only while a draft is open.
  selection: entry(
    { isOpen: Schema.Boolean },
    {
      modelToDependencies: model => ({
        isOpen: Option.isSome(model.maybeDraft),
      }),
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
  model: Model,
  title: string,
  children: ReadonlyArray<Html>,
  backHref: string = pathOf(AppRoute.Report({ reportId: model.reportId })),
  backLabel = 'Back to the report',
): Html =>
  h.section(
    [
      h.AriaLabel(title),
      h.Class('flex max-w-4xl flex-col gap-6 pb-14 pt-10 md:pt-14'),
    ],
    [
      h.a(
        [
          h.Href(backHref),
          h.Class(
            clsx('self-start text-base text-msf-ink underline', focusRing),
          ),
        ],
        [backLabel],
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

const sharedLine = (draft: {
  readonly sharedBy?: { readonly name: string } | undefined
  readonly sharedAt: number
}): string =>
  draft.sharedBy === undefined
    ? `Created with the report, ${momentText(draft.sharedAt)}`
    : `Shared by ${draft.sharedBy.name}, ${momentText(draft.sharedAt)}`

const VERBS = { added: 'Added', removed: 'Removed', changed: 'Changed' }

const changeLabel = (
  template: Template,
  change: { sectionId: string; itemId?: string | undefined },
): string => {
  const section = findSection(topLevelSections(template), change.sectionId)
  const sectionTitle = Option.match(section, {
    onNone: () => change.sectionId,
    onSome: found => found.title,
  })
  if (change.itemId === undefined) {
    return sectionTitle
  }
  const itemId = change.itemId
  const item = Option.flatMap(section, found => findItem(found, itemId))
  return `${sectionTitle} › ${Option.match(item, {
    onNone: () => itemId,
    onSome: found => found.label,
  })}`
}

const comparePanel = (
  h: HtmlBuilder<Message>,
  model: Model,
  template: Template,
  history: typeof History.Type,
): Html => {
  const choices = Array.map(history.drafts, draft => ({
    value: String(draft.number),
    label: draftLabel(draft.number),
  }))
  const select = (
    id: string,
    label: string,
    value: string,
    onChange: (value: string) => Message,
  ) =>
    h.div(
      [h.Class('flex flex-col gap-1')],
      [
        h.label(
          [h.Class('text-base font-medium text-msf-ink'), h.For(id)],
          [label],
        ),
        h.select(
          [
            h.Id(id),
            h.Value(value),
            h.Class(
              clsx(
                'h-12 border border-msf-line bg-white px-3 text-lg',
                focusRing,
              ),
            ),
            h.OnChange(onChange),
          ],
          Array.map(choices, choice =>
            h.option(
              [h.Value(choice.value), h.Selected(choice.value === value)],
              [choice.label],
            ),
          ),
        ),
      ],
    )
  return panel(
    h,
    'Compare two drafts',
    [
      h.form(
        [
          h.Class('flex flex-wrap items-end gap-4'),
          h.AriaLabel('Compare two drafts'),
          h.OnSubmit(Message.SubmittedCompare()),
        ],
        [
          select('compare-from', 'From', model.compareFrom, value =>
            Message.SelectedCompareFrom({ value }),
          ),
          select('compare-to', 'To', model.compareTo, value =>
            Message.SelectedCompareTo({ value }),
          ),
          h.button(
            [
              h.Type('submit'),
              h.Disabled(model.isComparing),
              h.Class(
                clsx(
                  'inline-flex min-h-12 cursor-pointer items-center justify-center bg-msf-ink px-5 text-lg font-medium text-white',
                  focusRing,
                ),
              ),
            ],
            [model.isComparing ? 'Comparing…' : 'Compare'],
          ),
        ],
      ),
      Option.match(model.maybeComparison, {
        onNone: () => h.empty,
        onSome: comparison =>
          h.div(
            [
              h.Class('flex flex-col gap-3'),
              h.DataAttribute('comparison', 'drafts'),
            ],
            [
              h.p(
                [h.Role('status'), h.Class('text-lg font-medium text-msf-ink')],
                [
                  `${draftLabel(comparison.from)} to ${draftLabel(comparison.to)}: ${
                    comparison.changes.length === 0
                      ? 'no changes to the text'
                      : `${comparison.changes.length} ${comparison.changes.length === 1 ? 'change' : 'changes'}`
                  }${comparison.peopleChanged ? ', and the people list changed' : ''}.`,
                ],
              ),
              Array.match(comparison.changes, {
                onEmpty: () => h.empty,
                onNonEmpty: changes =>
                  h.ul(
                    [
                      h.AriaLabel('Changes between the two drafts'),
                      h.Class(
                        'flex flex-col divide-y divide-msf-line border-y border-msf-line',
                      ),
                    ],
                    Array.map(changes, change =>
                      h.keyed('li')(
                        change.key,
                        [h.Class('py-3 text-lg text-msf-ink')],
                        [
                          `${VERBS[change.change]}: ${changeLabel(template, change)}`,
                        ],
                      ),
                    ),
                  ),
              }),
            ],
          ),
      }),
    ],
    Option.some('Shows which items differ. Open a draft to read it.'),
  )
}

const listView = (
  h: HtmlBuilder<Message>,
  model: Model,
  template: Template,
  history: typeof History.Type,
): Html =>
  shell(h, model, 'Draft history', [
    panel(
      h,
      'Shared drafts',
      [
        h.ul(
          [
            h.AriaLabel('Shared drafts'),
            h.Class(
              'flex flex-col divide-y divide-msf-line border-y border-msf-line',
            ),
          ],
          Array.map([...history.drafts].reverse(), draft =>
            h.keyed('li')(
              String(draft.number),
              [
                h.Class(
                  'flex flex-col gap-1 py-3 sm:flex-row sm:items-baseline sm:justify-between',
                ),
                h.DataAttribute('draft', String(draft.number)),
              ],
              [
                h.div(
                  [h.Class('flex flex-col')],
                  [
                    h.p(
                      [h.Class('text-xl font-bold text-msf-black')],
                      [draftLabel(draft.number)],
                    ),
                    h.p(
                      [h.Class('text-base text-msf-grey')],
                      [
                        `${sharedLine(draft)}${draft.baseDraft === undefined ? '' : `, from ${draftLabel(draft.baseDraft)}`}`,
                      ],
                    ),
                  ],
                ),
                link(
                  h,
                  pathOf(
                    AppRoute.Draft({
                      reportId: model.reportId,
                      draft: draft.number,
                    }),
                  ),
                  `Read ${draftLabel(draft.number)}`,
                ),
              ],
            ),
          ),
        ),
      ],
      Option.some('A shared draft never changes afterwards.'),
    ),
    comparePanel(h, model, template, history),
    Array.match(history.revisions, {
      onEmpty: () => h.empty,
      onNonEmpty: revisions =>
        panel(h, 'Published revisions', [
          h.ul(
            [
              h.AriaLabel('Published revisions'),
              h.Class(
                'flex flex-col divide-y divide-msf-line border-y border-msf-line',
              ),
            ],
            Array.map(revisions, revision =>
              h.keyed('li')(
                String(revision.number),
                [h.Class('py-3 text-lg text-msf-ink')],
                [
                  `${revision.label}, from ${draftLabel(revision.draft)}, published ${momentText(revision.publishedAt)}. ${revisionStatusText(revision)}`,
                ],
              ),
            ),
          ),
        ]),
    }),
  ])

const commentLocation = (
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
  if (comment.anchor.kind === 'section') {
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
        clsx('flex flex-col gap-3 py-4', comment.resolved && 'text-msf-grey'),
      ),
      h.DataAttribute('comment', comment.id),
      h.DataAttribute('resolved', comment.resolved ? 'true' : 'false'),
    ],
    [
      h.p(
        [h.Class('text-base text-msf-grey')],
        [
          `${comment.authorName}, ${momentText(comment.createdAt)}, on ${commentLocation(template, comment)}`,
          comment.resolved ? ' · Resolved' : '',
        ],
      ),
      comment.anchor.kind === 'text'
        ? h.blockquote(
            [
              h.Class(
                'border-l-4 border-msf-line pl-3 text-lg italic text-msf-ink',
              ),
            ],
            [comment.anchor.quoted],
          )
        : h.empty,
      h.p(
        [h.Class('whitespace-pre-wrap text-lg text-msf-ink')],
        [comment.body],
      ),
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
              [`${reply.authorName}, ${momentText(reply.createdAt)}`],
            ),
            h.p(
              [h.Class('whitespace-pre-wrap text-lg text-msf-ink')],
              [reply.body],
            ),
          ],
        ),
      ),
      mayComment(model)
        ? h.div(
            [h.Class('flex flex-col gap-2')],
            [
              h.label(
                [
                  h.Class('text-base font-medium text-msf-ink'),
                  h.For(`reply-${comment.id}`),
                ],
                ['Reply'],
              ),
              h.textarea([
                h.Id(`reply-${comment.id}`),
                h.Value(model.replyTexts[comment.id] ?? ''),
                h.Class(
                  clsx(
                    'min-h-20 w-full border border-msf-line bg-white px-3 py-2 text-lg',
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
                [model.isSending ? 'Sending…' : 'Add comment'],
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

const commentsPanel = (
  h: HtmlBuilder<Message>,
  model: Model,
  template: Template,
  state: typeof ViewState.Type,
): Html =>
  panel(
    h,
    'Comments on this draft',
    [
      mayComment(model)
        ? h.div(
            [h.Class('flex flex-col gap-3')],
            [
              h.div(
                [h.Class('flex flex-wrap gap-2')],
                [
                  actionButton(
                    h,
                    'Comment on selected text',
                    'Comment on the selected text',
                    Message.ClickedCommentOnText(),
                    Option.isNone(model.maybeSelection),
                  ),
                  actionButton(
                    h,
                    'Comment on this section',
                    'Comment on this section',
                    Message.ClickedCommentOnSection(),
                  ),
                ],
              ),
              Option.match(model.maybeSelection, {
                onNone: () =>
                  h.p(
                    [h.Class('text-base text-msf-grey')],
                    ['Select some text above to comment on it.'],
                  ),
                onSome: selection =>
                  h.p(
                    [
                      h.Class('text-base text-msf-ink'),
                      h.DataAttribute('selected', 'true'),
                    ],
                    [`Selected: "${selection.quoted}"`],
                  ),
              }),
              composerView(h, model, template),
            ],
          )
        : h.empty,
      Option.match(model.maybeNotice, {
        onNone: () => h.empty,
        onSome: notice => alertText(h, notice),
      }),
      Array.match(state.comments, {
        onEmpty: () =>
          h.p([h.Class('text-lg text-msf-grey')], ['No comments yet.']),
        onNonEmpty: comments =>
          h.ul(
            [
              h.AriaLabel('Comments on this draft'),
              h.Class(
                'flex flex-col divide-y divide-msf-line border-y border-msf-line',
              ),
            ],
            Array.map(comments, comment =>
              commentCard(h, model, template, comment),
            ),
          ),
      }),
    ],
    Option.some('Only the authors of this report see these comments.'),
  )

const draftView = (
  h: HtmlBuilder<Message>,
  model: Model,
  template: Template,
  history: typeof History.Type,
  state: typeof ViewState.Type,
): Html => {
  const header = state.outline.header
  const sections = topLevelSections(template)
  const current = Array.findFirst(sections, s => s.id === model.sectionId)
  return shell(
    h,
    model,
    draftLabel(header.number),
    [
      h.p(
        [h.Class('text-base text-msf-grey')],
        [
          `${sharedLine(header)}${header.baseDraft === undefined ? '' : `, from ${draftLabel(header.baseDraft)}`}. Read-only: a shared draft never changes.`,
        ],
      ),
      h.nav(
        [h.AriaLabel('Sections'), h.Class('flex flex-wrap gap-2')],
        Array.map(sections, section =>
          h.keyed('button')(
            section.id,
            [
              h.Type('button'),
              ...(section.id === model.sectionId
                ? [h.AriaCurrent('true')]
                : []),
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
            [section.title],
          ),
        ),
      ),
      model.isSectionLoading
        ? loadingText(h, 'Loading the section.')
        : Option.match(current, {
            onNone: () => h.empty,
            onSome: section =>
              h.article(
                [
                  h.AriaLabel(section.title),
                  h.DataAttribute('draft-section', section.id),
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
                      people: state.people,
                      topSectionId: section.id,
                      ...Option.match(model.maybeDraft, {
                        onNone: () => ({}),
                        onSome: draft => ({
                          imageContext: imageContextToken({
                            kind: 'draft',
                            draft,
                          }),
                        }),
                      }),
                    },
                  ),
                ],
              ),
          }),
      commentsPanel(h, model, template, state),
      link(
        h,
        pathOf(AppRoute.Drafts({ reportId: model.reportId })),
        'Draft history',
      ),
    ],
    pathOf(AppRoute.Drafts({ reportId: model.reportId })),
    'Back to the draft history',
  )
}

export const view = Submodel.defineView<Model, Message>((model, h) =>
  LoadState.match(model.load, {
    Loading: () =>
      shell(h, model, 'Draft history', [loadingText(h, 'Loading.')]),
    Failed: ({ failure }) =>
      shell(h, model, 'Draft history', [
        failure._tag === 'NotAllowed'
          ? alertText(h, 'This report is not available to you.')
          : alertText(h, failureText(failure)),
        actionButton(h, 'Try again', 'Try again', Message.ClickedRetryLoad()),
      ]),
    Loaded: () =>
      Option.match(
        Option.all({
          template: model.maybeTemplate,
          history: model.maybeHistory,
        }),
        {
          onNone: () =>
            shell(h, model, 'Draft history', [loadingText(h, 'Loading.')]),
          onSome: ({ template, history }) =>
            Option.match(model.maybeView, {
              onNone: () =>
                Option.isSome(model.maybeDraft)
                  ? shell(h, model, 'Draft history', [
                      statusText(h, 'This draft is not available.'),
                    ])
                  : listView(h, model, template, history),
              onSome: state => draftView(h, model, template, history, state),
            }),
        },
      ),
  }),
)
