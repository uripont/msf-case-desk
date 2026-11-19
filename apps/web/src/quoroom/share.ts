import { clsx } from 'clsx'
import {
  Array,
  Clock,
  Crypto,
  Effect,
  Option,
  Record,
  Result,
  Schema,
} from 'effect'
import { Command, Submodel, Update } from 'foldkit'
import { Html, HtmlBuilder } from 'foldkit/html'
import { defineMessageUnion } from 'foldkit/message'
import { defineTaggedUnion } from 'foldkit/schema'
import { modifyFields } from 'foldkit/struct'

import {
  Comparison,
  ConflictChoiceSchema,
  type ItemEntry,
  PeopleList,
  type Person,
  PublishChoices,
  PublishTerms,
  ReportDetail,
  type Section,
  SectionContent,
  type SectionEntry,
  ShareOutcome,
  Template,
  canonicalJson,
  draftLabel,
  peopleListProblems,
  redactedCaseOf,
  redactedSectionOf,
} from '@quoroom/domain'
import { BrowserCrypto } from '@effect/platform-browser'

import { AppRoute, pathOf } from '../route'
import { focusRing } from '../style'
import { withQuoroom } from './api'
import { readOnlySection, valueView } from './contentView'
import {
  entryTitles,
  findItemAnywhere,
  findSection,
  keyLabel,
  topLevelSections,
} from './draftText'
import {
  EMPTY_RICH_TEXT_JSON,
  parseRichTextJson,
  serializeRichText,
} from './editor/richText'
import { editorElement } from './editor/spec'
import { EditorState } from './editor/state'
import { actionButton } from './entryViews'
import { Failure, failureOf, failureText, isReloadConflict } from './failure'
import { redactionHashOf, sha256Hex } from './hash'
import * as PublishForm from './publishForm'
import { PreviewView, previewAll, viewNote, viewToggle } from './redactedView'
import { PageScope, isCurrentPage, pageScopeOf } from './scope'
import { alertText, checkboxField, loadingText, panel, statusText } from './ui'
import { LoadState } from './unit'

// NOTE: Sharing the author's working copy as the next draft, at
// `/r/:id/share`. The browser drives the sequence: one
// `ShareSection` per section, then a guarded `FinishShare`. Progress is shown
// and a failure can be resumed at the section it stopped on, with the same
// share ID, so nothing already staged is sent twice. If a draft was shared in
// the meantime the comparison screen takes over: what only one author changed
// is listed as taken automatically, and each item both changed needs a choice
// (ours, theirs; for rich text also a combined version typed in the editor; a
// new label for a person; which entries to keep when together they pass the
// limit). `ResolveMerge` then rebases the working copy on the latest draft
// and the share runs again.

type Draft = typeof ConflictChoiceSchema.Type

// NOTE: What the author has chosen for a conflict so far.
export const Choice = defineTaggedUnion({
  Side: { side: Schema.Literals(['ours', 'theirs']) },
  Edited: { content: Schema.String, version: Schema.Int },
  Label: { text: Schema.String },
  Keep: { ids: Schema.Array(Schema.String) },
})
export type Choice = typeof Choice.Type

export const CopyOutline = Schema.Struct({
  saveCounter: Schema.Int,
  baseDraft: Schema.Int,
  latestDraft: Schema.Int,
  behind: Schema.Boolean,
  hasUnsharedChanges: Schema.Boolean,
  sectionIds: Schema.Array(Schema.String),
})
export type CopyOutline = typeof CopyOutline.Type

export const Phase = defineTaggedUnion({
  Ready: {},
  Staging: { shareId: Schema.String, next: Schema.Int },
  Finishing: { shareId: Schema.String },
  Failed: {
    shareId: Schema.String,
    // NOTE: The section to resume at; the number of sections means the finish.
    next: Schema.Int,
    failure: Failure,
    // NOTE: The working copy or the draft changed meanwhile (another tab, a
    // draft shared, the people list edited): resuming can only fail again, so
    // the page offers to load it again and share from there.
    needsReload: Schema.Boolean,
  },
  Comparing: {},
  Resolving: {},
  Shared: { draft: Schema.Int, maybeRevision: Schema.Option(Schema.Int) },
})
export type Phase = typeof Phase.Type

export const Model = Schema.Struct({
  origin: Schema.String,
  reportId: Schema.String,
  generation: Schema.Int,
  load: LoadState,
  maybeDetail: Schema.Option(ReportDetail),
  maybeTemplate: Schema.Option(Template),
  people: PeopleList,
  // NOTE: The author's working copy, section by section, for the preview.
  contents: Schema.Record(Schema.String, SectionContent),
  view: PreviewView,
  // NOTE: The hashes of the redacted sections the server staged, in section
  // order, and the hash of the people list they were made with: what the
  // confirmation is made of.
  stagedHashes: Schema.Array(Schema.String),
  peopleHash: Schema.String,
  // NOTE: The server's hash of the redacted case title and reference read when
  // the sections were staged; it is part of the confirmation.
  caseHash: Schema.String,
  maybeCopy: Schema.Option(CopyOutline),
  maybeComparison: Schema.Option(Comparison),
  choices: Schema.Record(Schema.String, Choice),
  maybePublishChoices: Schema.Option(PublishChoices),
  publishForm: PublishForm.Model,
  wantsPublish: Schema.Boolean,
  nowMs: Schema.Int,
  publishProblems: Schema.Array(Schema.String),
  phase: Phase,
  editor: EditorState,
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
  people: [],
  contents: {},
  view: 'redacted',
  stagedHashes: [],
  peopleHash: '',
  caseHash: '',
  maybeCopy: Option.none(),
  maybeComparison: Option.none(),
  choices: {},
  maybePublishChoices: Option.none(),
  publishForm: PublishForm.initialModel,
  wantsPublish: false,
  nowMs: 0,
  publishProblems: [],
  phase: Phase.Ready(),
  editor: EditorState.NotLoaded(),
  maybeNotice: Option.none(),
})

export const LoadedShare = Schema.Struct({
  detail: ReportDetail,
  template: Template,
  people: PeopleList,
  contents: Schema.Record(Schema.String, SectionContent),
  copy: CopyOutline,
  maybeComparison: Schema.Option(Comparison),
  maybePublishChoices: Schema.Option(PublishChoices),
  nowMs: Schema.Int,
  timeZone: Schema.String,
})
export type LoadedShare = typeof LoadedShare.Type

export const Message = defineMessageUnion({
  SucceededLoadShare: { scope: PageScope, loaded: LoadedShare },
  FailedLoadShare: { scope: PageScope, failure: Failure },
  ClickedRetryLoad: {},
  ClickedReloadShare: {},
  ClickedShare: {},
  ChoseView: { view: PreviewView },
  ToggledPublish: {},
  GotPublishFormMessage: { message: PublishForm.Message },
  GeneratedShareId: { scope: PageScope, shareId: Schema.String },
  SucceededStageSection: {
    scope: PageScope,
    shareId: Schema.String,
    index: Schema.Int,
    redactedHash: Schema.String,
    peopleHash: Schema.String,
    caseHash: Schema.String,
  },
  FailedStageSection: {
    scope: PageScope,
    shareId: Schema.String,
    index: Schema.Int,
    failure: Failure,
    needsReload: Schema.Boolean,
  },
  SucceededFinishShare: {
    scope: PageScope,
    shareId: Schema.String,
    outcome: ShareOutcome,
  },
  FailedFinishShare: {
    scope: PageScope,
    shareId: Schema.String,
    failure: Failure,
    needsReload: Schema.Boolean,
  },
  ClickedResume: {},
  ChoseSide: { key: Schema.String, side: Schema.Literals(['ours', 'theirs']) },
  ChoseCombined: { key: Schema.String },
  ChangedCombined: {
    key: Schema.String,
    content: Schema.String,
    version: Schema.Int,
  },
  TypedLabel: { key: Schema.String, text: Schema.String },
  ChoseLabel: { key: Schema.String },
  ToggledKeep: { key: Schema.String, id: Schema.String },
  ChoseKeep: { key: Schema.String },
  ClickedResolve: {},
  SucceededResolveMerge: { scope: PageScope, copy: CopyOutline },
  FailedResolveMerge: { scope: PageScope, failure: Failure },
  SucceededLoadEditor: {},
  FailedLoadEditor: {},
  ClickedRetryLoadEditor: {},
})
export type Message = typeof Message.Type

// COMMAND

const copyOf = (outline: {
  saveCounter: number
  baseDraft: number
  latestDraft: number
  behind: boolean
  hasUnsharedChanges: boolean
  sections: ReadonlyArray<{ sectionId: string }>
}): CopyOutline => ({
  saveCounter: outline.saveCounter,
  baseDraft: outline.baseDraft,
  latestDraft: outline.latestDraft,
  behind: outline.behind,
  hasUnsharedChanges: outline.hasUnsharedChanges,
  sectionIds: Array.map(outline.sections, section => section.sectionId),
})

export const LoadShare = Command.define('LoadShare', {
  args: { scope: PageScope },
  messages: [Message.SucceededLoadShare, Message.FailedLoadShare],
  execute: ({ scope }) => {
    const { reportId } = scope
    return withQuoroom(client =>
      Effect.gen(function* () {
        const detail = yield* client.GetReport({ reportId })
        const version = yield* client.GetTemplateVersion({
          templateId: detail.summary.templateId,
          version: detail.summary.templateVersion,
          reportId,
        })
        yield* client.StartWorkingCopy({ reportId })
        const outline = yield* client.GetWorkingCopy({ reportId })
        const people = yield* client.GetPeople({ reportId })
        const sections = yield* Effect.forEach(
          outline.sections,
          section =>
            client.GetWorkingCopySection({
              reportId,
              sectionId: section.sectionId,
            }),
          { concurrency: 4 },
        )
        const maybeComparison = outline.behind
          ? Option.some(yield* client.PreviewMerge({ reportId }))
          : Option.none()
        const maybePublishChoices = yield* client
          .GetPublishChoices({ reportId })
          .pipe(
            Effect.map(choices => Option.some(choices)),
            Effect.catch(() => Effect.succeed(Option.none())),
          )
        const nowMs = yield* Clock.currentTimeMillis
        return {
          detail,
          template: version.template,
          people: people.people,
          contents: Object.fromEntries(
            sections.map(section => [section.sectionId, section.content]),
          ),
          copy: copyOf(outline),
          maybeComparison,
          maybePublishChoices,
          nowMs,
          timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        }
      }),
    ).pipe(
      Effect.map(loaded => Message.SucceededLoadShare({ scope, loaded })),
      Effect.catch(error =>
        Effect.succeed(
          Message.FailedLoadShare({ scope, failure: failureOf(error) }),
        ),
      ),
    )
  },
})

// NOTE: The ID of one share, the same for each of its requests, chosen here.
export const NewShareId = Command.define('NewShareId', {
  args: { scope: PageScope },
  messages: [Message.GeneratedShareId],
  execute: ({ scope }) =>
    Effect.flatMap(Crypto.Crypto, crypto => crypto.randomUUIDv4).pipe(
      Effect.provide(BrowserCrypto.layer),
      Effect.map(uuid =>
        Message.GeneratedShareId({
          scope,
          shareId: `share-${uuid.replaceAll('-', '').slice(0, 24)}`,
        }),
      ),
      Effect.catch(() =>
        Effect.succeed(Message.GeneratedShareId({ scope, shareId: '' })),
      ),
    ),
})

export const StageSection = Command.define('StageSection', {
  args: {
    scope: PageScope,
    shareId: Schema.String,
    sectionId: Schema.String,
    saveCounter: Schema.Int,
    index: Schema.Int,
    // NOTE: The redacted section as the author saw it in the preview, as
    // canonical JSON. The server's hash of what it staged must be the hash of
    // this text, or what is shared is not what was seen.
    previewJson: Schema.String,
    // NOTE: The redacted case title and reference as the preview showed them,
    // as canonical JSON; the server's `caseHash` must be the hash of this.
    previewCaseJson: Schema.String,
  },
  messages: [Message.SucceededStageSection, Message.FailedStageSection],
  execute: ({
    scope,
    shareId,
    sectionId,
    saveCounter,
    index,
    previewJson,
    previewCaseJson,
  }) =>
    withQuoroom(client =>
      Effect.gen(function* () {
        const staged = yield* client.ShareSection({
          reportId: scope.reportId,
          shareId,
          sectionId,
          saveCounter,
        })
        const seen = yield* Effect.promise(() => sha256Hex(previewJson))
        const seenCase = yield* Effect.promise(() => sha256Hex(previewCaseJson))
        return { staged, seen, seenCase }
      }),
    ).pipe(
      Effect.map(({ staged, seen, seenCase }) =>
        seen === staged.redactedHash && seenCase === staged.caseHash
          ? Message.SucceededStageSection({
              scope,
              shareId,
              index,
              redactedHash: staged.redactedHash,
              peopleHash: staged.peopleHash,
              caseHash: staged.caseHash,
            })
          : Message.FailedStageSection({
              scope,
              shareId,
              index,
              failure: Failure.Refused({
                message:
                  'The text to be shared is not the text of the preview, so nothing was confirmed.',
              }),
              needsReload: true,
            }),
      ),
      Effect.catch(error =>
        Effect.succeed(
          Message.FailedStageSection({
            scope,
            shareId,
            index,
            failure: failureOf(error),
            needsReload: isReloadConflict(error),
          }),
        ),
      ),
    ),
})

export const FinishShare = Command.define('FinishShare', {
  args: {
    scope: PageScope,
    shareId: Schema.String,
    saveCounter: Schema.Int,
    stagedHashes: Schema.Array(Schema.String),
    peopleHash: Schema.String,
    caseHash: Schema.String,
    maybePublish: Schema.Option(PublishTerms),
  },
  messages: [Message.SucceededFinishShare, Message.FailedFinishShare],
  execute: ({
    scope,
    shareId,
    saveCounter,
    stagedHashes,
    peopleHash,
    caseHash,
    maybePublish,
  }) =>
    withQuoroom(client =>
      Effect.gen(function* () {
        // NOTE: The confirmation of the preview (D14): the hash of what was
        // staged and of the people list it was made with. The server checks it
        // against what it holds and writes it with the draft.
        const redactionHash = yield* Effect.promise(() =>
          redactionHashOf(stagedHashes, peopleHash, caseHash),
        )
        return yield* client.FinishShare({
          reportId: scope.reportId,
          shareId,
          saveCounter,
          redactionHash,
          ...Option.match(maybePublish, {
            onNone: () => ({}),
            onSome: publish => ({ publish }),
          }),
        })
      }),
    ).pipe(
      Effect.map(outcome =>
        Message.SucceededFinishShare({ scope, shareId, outcome }),
      ),
      Effect.catch(error =>
        Effect.succeed(
          Message.FailedFinishShare({
            scope,
            shareId,
            failure: failureOf(error),
            needsReload: isReloadConflict(error),
          }),
        ),
      ),
    ),
})

export const ResolveMerge = Command.define('ResolveMerge', {
  args: {
    scope: PageScope,
    saveCounter: Schema.Int,
    choices: Schema.Record(Schema.String, ConflictChoiceSchema),
  },
  messages: [Message.SucceededResolveMerge, Message.FailedResolveMerge],
  execute: ({ scope, saveCounter, choices }) =>
    withQuoroom(client =>
      client.ResolveMerge({ reportId: scope.reportId, saveCounter, choices }),
    ).pipe(
      Effect.map(outline =>
        Message.SucceededResolveMerge({ scope, copy: copyOf(outline) }),
      ),
      Effect.catch(error =>
        Effect.succeed(
          Message.FailedResolveMerge({ scope, failure: failureOf(error) }),
        ),
      ),
    ),
})

export const LoadEditor = Command.define('LoadEditor', {
  messages: [Message.SucceededLoadEditor, Message.FailedLoadEditor],
  execute: Effect.tryPromise(() => import('./editor/element')).pipe(
    Effect.as(Message.SucceededLoadEditor()),
    Effect.catch(() => Effect.succeed(Message.FailedLoadEditor())),
  ),
})

// QUERIES

// NOTE: The choices as the API takes them, or none while any conflict still
// lacks a valid one.
export const draftsOf = (
  comparison: Comparison,
  choices: Readonly<Record<string, Choice>>,
): Option.Option<Readonly<Record<string, Draft>>> => {
  const out: Record<string, Draft> = {}
  for (const conflict of comparison.conflicts) {
    const choice = choices[conflict.key]
    if (choice === undefined) {
      return Option.none()
    }
    const made = Choice.match(choice, {
      Side: ({ side }): Option.Option<Draft> => Option.some(side),
      Edited: ({ content }): Option.Option<Draft> =>
        Option.map(parseRichTextJson(content), edited => ({ edited })),
      Label: ({ text }): Option.Option<Draft> =>
        text.trim() === ''
          ? Option.none()
          : Option.some({ label: text.trim() }),
      Keep: ({ ids }): Option.Option<Draft> =>
        conflict.kind === 'entries_limit' && ids.length > conflict.max
          ? Option.none()
          : Option.some({ keep: [...ids] }),
    })
    if (Option.isNone(made)) {
      return Option.none()
    }
    out[conflict.key] = made.value
  }
  return Option.some(out)
}

export const canShare = (model: Model): boolean =>
  Option.match(model.maybeCopy, {
    onNone: () => false,
    onSome: copy => copy.hasUnsharedChanges || copy.behind,
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
  return { model: fresh, commands: [LoadShare({ scope: pageScopeOf(fresh) })] }
}

export const cleared = (model: Model): Model =>
  modifyFields(initialModel, { generation: () => model.generation + 1 })

// UPDATE

const EMPTY_SECTION: SectionContent = { values: {}, sections: {} }

// NOTE: The redacted section as the preview shows it, as the canonical text the
// server's hash is made of (`redactedSectionOf`, shared with the server).
const previewJsonOf = (model: Model, sectionId: string): string =>
  Option.match(model.maybeTemplate, {
    onNone: () => '',
    onSome: template =>
      canonicalJson(
        redactedSectionOf(
          template,
          model.people,
          sectionId,
          model.contents[sectionId] ?? EMPTY_SECTION,
        ),
      ),
  })

// NOTE: The case title and reference as the preview shows them, redacted, as
// the text the server's `caseHash` must be the hash of.
const previewCaseJsonOf = (model: Model): string =>
  Option.match(model.maybeDetail, {
    onNone: () => '',
    onSome: detail =>
      canonicalJson(
        redactedCaseOf(
          model.people,
          detail.summary.caseFile.title,
          detail.summary.caseFile.reference,
        ),
      ),
  })

// NOTE: A list the server would refuse to redact with (a duplicate label, a
// label that holds a name) cannot be shared; the people screen says why.
export const peopleProblemCount = (model: Model): number =>
  peopleListProblems(model.people).length

export const publishContextOf = (
  model: Model,
): Option.Option<PublishForm.FormContext> =>
  Option.map(
    Option.all({
      detail: model.maybeDetail,
      template: model.maybeTemplate,
      choices: model.maybePublishChoices,
    }),
    ({ detail, template, choices }) => ({
      template,
      unit: detail.summary.caseFile.unit,
      authors: Array.map(detail.authors, author => author.id),
      choices,
      nowMs: model.nowMs,
    }),
  )

// NOTE: The terms of "share and publish", once the form holds a deadline and
// choices that can be published; none when the author only shares.
const publishTermsOf = (model: Model): Option.Option<PublishTerms> =>
  model.wantsPublish
    ? Option.flatMap(publishContextOf(model), context =>
        Result.match(PublishForm.termsOf(model.publishForm, context), {
          onSuccess: terms => Option.some(terms),
          onFailure: () => Option.none(),
        }),
      )
    : Option.none()

const stageCommand = (
  model: Model,
  shareId: string,
  index: number,
): Update.Return<Model, Message> =>
  Option.match(model.maybeCopy, {
    onNone: () => ({ model }),
    onSome: copy => {
      const sectionId = copy.sectionIds[index]
      return sectionId === undefined
        ? {
            model: modifyFields(model, {
              phase: () => Phase.Finishing({ shareId }),
            }),
            commands: [
              FinishShare({
                scope: pageScopeOf(model),
                shareId,
                saveCounter: copy.saveCounter,
                stagedHashes: model.stagedHashes,
                peopleHash: model.peopleHash,
                caseHash: model.caseHash,
                maybePublish: publishTermsOf(model),
              }),
            ],
          }
        : {
            model: modifyFields(model, {
              phase: () => Phase.Staging({ shareId, next: index }),
              stagedHashes: hashes => Array.take(hashes, index),
            }),
            commands: [
              StageSection({
                scope: pageScopeOf(model),
                shareId,
                sectionId,
                saveCounter: copy.saveCounter,
                index,
                previewJson: previewJsonOf(model, sectionId),
                previewCaseJson: previewCaseJsonOf(model),
              }),
            ],
          }
    },
  })

const startsEditor = (model: Model): Update.Return<Model, Message> =>
  EditorState.guards.NotLoaded(model.editor)
    ? {
        model: modifyFields(model, { editor: () => EditorState.Loading() }),
        commands: [LoadEditor()],
      }
    : { model }

const withChoice = (model: Model, key: string, choice: Choice): Model =>
  modifyFields(model, { choices: choices => Record.set(choices, key, choice) })

const keptOf = (model: Model, key: string): ReadonlyArray<string> =>
  Option.match(Record.get(model.choices, key), {
    onNone: () => [],
    onSome: choice => (Choice.guards.Keep(choice) ? choice.ids : []),
  })

// NOTE: An answer about a share that is no longer the one in progress is
// dropped.
const isSharing = (model: Model, shareId: string): boolean =>
  (Phase.guards.Staging(model.phase) || Phase.guards.Finishing(model.phase)) &&
  model.phase.shareId === shareId

const updateCurrent = (model: Model, message: Message) =>
  Message.match<Update.Return<Model, Message>>(message, {
    SucceededLoadShare: ({ loaded }) => ({
      model: modifyFields(model, {
        load: () => LoadState.Loaded(),
        maybeDetail: () => Option.some(loaded.detail),
        maybeTemplate: () => Option.some(loaded.template),
        people: () => loaded.people,
        contents: () => loaded.contents,
        stagedHashes: () => [],
        peopleHash: () => '',
        caseHash: () => '',
        maybeCopy: () => Option.some(loaded.copy),
        maybeComparison: () => loaded.maybeComparison,
        maybePublishChoices: () => loaded.maybePublishChoices,
        nowMs: () => loaded.nowMs,
        publishForm: () =>
          PublishForm.defaultsFor(loaded.nowMs, loaded.timeZone),
        phase: () =>
          Option.isSome(loaded.maybeComparison)
            ? Phase.Comparing()
            : Phase.Ready(),
      }),
    }),
    FailedLoadShare: ({ failure }) => ({
      model: modifyFields(model, { load: () => LoadState.Failed({ failure }) }),
    }),
    ClickedRetryLoad: () => ({
      model: modifyFields(model, { load: () => LoadState.Loading() }),
      commands: [LoadShare({ scope: pageScopeOf(model) })],
    }),
    ClickedReloadShare: () => ({
      model: modifyFields(model, {
        load: () => LoadState.Loading(),
        phase: () => Phase.Ready(),
        choices: () => ({}),
        maybeNotice: () => Option.none(),
      }),
      commands: [LoadShare({ scope: pageScopeOf(model) })],
    }),
    ChoseView: ({ view }) => ({
      model: modifyFields(model, { view: () => view }),
    }),
    ToggledPublish: () => ({
      model: modifyFields(model, {
        wantsPublish: wants => !wants,
        publishProblems: () => [],
      }),
    }),
    GotPublishFormMessage: ({ message: formMessage }) => {
      const formUpdate = PublishForm.update(model.publishForm, formMessage)
      return {
        model: modifyFields(model, {
          publishForm: () => formUpdate.model,
          publishProblems: () => [],
        }),
      }
    },
    ClickedShare: () => {
      if (
        !(
          Phase.guards.Ready(model.phase) &&
          canShare(model) &&
          peopleProblemCount(model) === 0
        )
      ) {
        return { model }
      }
      const refusal = model.wantsPublish
        ? Option.match(publishContextOf(model), {
            onNone: () => Option.some(['Publishing is not available.']),
            onSome: context => {
              const terms = PublishForm.termsOf(model.publishForm, context)
              return Result.isFailure(terms)
                ? Option.some(terms.failure)
                : Option.none()
            },
          })
        : Option.none()
      return Option.match(refusal, {
        onNone: () => ({
          model: modifyFields(model, { publishProblems: () => [] }),
          commands: [NewShareId({ scope: pageScopeOf(model) })],
        }),
        onSome: problems => ({
          model: modifyFields(model, { publishProblems: () => problems }),
        }),
      })
    },
    GeneratedShareId: ({ shareId }) =>
      shareId === ''
        ? {
            model: modifyFields(model, {
              phase: () =>
                Phase.Failed({
                  shareId: '',
                  next: 0,
                  failure: Failure.Unavailable(),
                  needsReload: false,
                }),
            }),
          }
        : stageCommand(
            modifyFields(model, { maybeNotice: () => Option.none() }),
            shareId,
            0,
          ),
    SucceededStageSection: ({
      shareId,
      index,
      redactedHash,
      peopleHash,
      caseHash,
    }) =>
      isSharing(model, shareId)
        ? stageCommand(
            modifyFields(model, {
              stagedHashes: hashes => [
                ...Array.take(hashes, index),
                redactedHash,
              ],
              peopleHash: () => peopleHash,
              caseHash: () => caseHash,
            }),
            shareId,
            index + 1,
          )
        : { model },
    FailedStageSection: ({ shareId, index, failure, needsReload }) =>
      isSharing(model, shareId)
        ? {
            model: modifyFields(model, {
              phase: () =>
                Phase.Failed({ shareId, next: index, failure, needsReload }),
            }),
          }
        : { model },
    SucceededFinishShare: ({ shareId, outcome }) =>
      !isSharing(model, shareId)
        ? { model }
        : outcome.kind === 'shared'
          ? {
              model: modifyFields(model, {
                phase: () =>
                  Phase.Shared({
                    draft: outcome.draft.number,
                    maybeRevision: Option.fromNullishOr(
                      outcome.revision?.number,
                    ),
                  }),
                maybeComparison: () => Option.none(),
              }),
            }
          : {
              model: modifyFields(model, {
                phase: () => Phase.Comparing(),
                maybeComparison: () => Option.some(outcome.comparison),
                choices: () => ({}),
                maybeNotice: () =>
                  Option.some(
                    `${draftLabel(outcome.latestDraft)} was shared while you were working. Compare the two and choose what to keep.`,
                  ),
              }),
            },
    FailedFinishShare: ({ shareId, failure, needsReload }) =>
      isSharing(model, shareId) &&
      model.wantsPublish &&
      Failure.guards.Refused(failure)
        ? {
            model: modifyFields(model, {
              phase: () => Phase.Ready(),
              publishProblems: () => [failureText(failure)],
            }),
          }
        : isSharing(model, shareId)
          ? {
              model: modifyFields(model, {
                phase: () =>
                  Phase.Failed({
                    shareId,
                    next: Option.match(model.maybeCopy, {
                      onNone: () => 0,
                      onSome: copy => copy.sectionIds.length,
                    }),
                    failure,
                    needsReload,
                  }),
              }),
            }
          : { model },
    ClickedResume: () =>
      Phase.guards.Failed(model.phase)
        ? model.phase.shareId === ''
          ? {
              model: modifyFields(model, { phase: () => Phase.Ready() }),
              commands: [NewShareId({ scope: pageScopeOf(model) })],
            }
          : stageCommand(model, model.phase.shareId, model.phase.next)
        : { model },
    ChoseSide: ({ key, side }) => ({
      model: withChoice(model, key, Choice.Side({ side })),
    }),
    ChoseCombined: ({ key }) =>
      Option.match(model.maybeComparison, {
        onNone: () => ({ model }),
        onSome: comparison => {
          const start = Option.flatMap(
            Array.findFirst(
              comparison.conflicts,
              candidate => candidate.key === key,
            ),
            found => {
              if (found.kind !== 'value') {
                return Option.none()
              }
              const rich = [found.ours, found.theirs].find(
                value => value?.type === 'rich_text',
              )
              return rich?.type === 'rich_text'
                ? Option.some(rich.doc)
                : Option.none()
            },
          )
          return startsEditor(
            withChoice(
              model,
              key,
              Choice.Edited({
                content: Option.match(start, {
                  onNone: () => EMPTY_RICH_TEXT_JSON,
                  onSome: doc => serializeRichText(doc),
                }),
                version: 1,
              }),
            ),
          )
        },
      }),
    ChangedCombined: ({ key, content, version }) => ({
      model: withChoice(model, key, Choice.Edited({ content, version })),
    }),
    TypedLabel: ({ key, text }) => ({
      model: withChoice(model, key, Choice.Label({ text })),
    }),
    ChoseLabel: ({ key }) => ({
      model: withChoice(model, key, Choice.Label({ text: '' })),
    }),
    ToggledKeep: ({ key, id }) => {
      const kept = keptOf(model, key)
      return {
        model: withChoice(
          model,
          key,
          Choice.Keep({
            ids: Array.contains(kept, id)
              ? Array.filter(kept, other => other !== id)
              : [...kept, id],
          }),
        ),
      }
    },
    ChoseKeep: ({ key }) => ({
      model: withChoice(
        model,
        key,
        Choice.Keep({
          ids: Option.match(model.maybeComparison, {
            onNone: () => [],
            onSome: comparison =>
              Option.match(
                Array.findFirst(
                  comparison.conflicts,
                  conflict => conflict.key === key,
                ),
                {
                  onNone: () => [],
                  onSome: conflict =>
                    conflict.kind === 'entries_limit'
                      ? conflict.merged.slice(0, conflict.max)
                      : [],
                },
              ),
          }),
        }),
      ),
    }),
    ClickedResolve: () =>
      Option.match(
        Option.all({
          comparison: model.maybeComparison,
          copy: model.maybeCopy,
        }),
        {
          onNone: () => ({ model }),
          onSome: ({ comparison, copy }) =>
            Option.match(draftsOf(comparison, model.choices), {
              onNone: () => ({
                model: modifyFields(model, {
                  maybeNotice: () =>
                    Option.some('Choose what to keep for every item below.'),
                }),
              }),
              onSome: choices => ({
                model: modifyFields(model, {
                  phase: () => Phase.Resolving(),
                  maybeNotice: () => Option.none(),
                }),
                commands: [
                  ResolveMerge({
                    scope: pageScopeOf(model),
                    saveCounter: copy.saveCounter,
                    choices: { ...choices },
                  }),
                ],
              }),
            }),
        },
      ),
    SucceededResolveMerge: ({ copy }) => ({
      model: modifyFields(model, {
        maybeCopy: () => Option.some(copy),
        maybeComparison: () => Option.none(),
        choices: () => ({}),
        phase: () => Phase.Ready(),
        load: () => LoadState.Loading(),
        contents: () => ({}),
        stagedHashes: () => [],
        peopleHash: () => '',
        caseHash: () => '',
      }),
      // NOTE: The combined text is read again and shown as the preview, so
      // the author confirms exactly what the combination will share.
      commands: [LoadShare({ scope: pageScopeOf(model) })],
    }),
    FailedResolveMerge: ({ failure }) => ({
      model: modifyFields(model, {
        phase: () => Phase.Comparing(),
        maybeNotice: () => Option.some(failureText(failure)),
      }),
    }),
    SucceededLoadEditor: () => ({
      model: modifyFields(model, { editor: () => EditorState.Ready() }),
    }),
    FailedLoadEditor: () => ({
      model: modifyFields(model, { editor: () => EditorState.Failed() }),
    }),
    ClickedRetryLoadEditor: () => ({
      model: modifyFields(model, { editor: () => EditorState.Loading() }),
      commands: [LoadEditor()],
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

const LAST_ITEM = /(?:^|\/)i:([^/]+)$/

const lastItemId = (key: string): string | undefined => LAST_ITEM.exec(key)?.[1]

type Conflict = Comparison['conflicts'][number]

type ViewState = Readonly<{
  template: Template
  people: ReadonlyArray<Person>
  reportId: string
  titles: Readonly<Record<string, string>>
}>

const titleOfId = (state: ViewState, id: string): string =>
  state.titles[id] ?? 'An entry'

const muted = 'text-base italic text-msf-grey'

const entryBox = <M>(
  h: HtmlBuilder<M>,
  state: ViewState,
  entry: SectionEntry | ItemEntry | undefined,
): Html => {
  if (entry === undefined) {
    return h.p([h.Class(muted)], ['Not there (deleted).'])
  }
  const context = {
    reportId: state.reportId,
    people: state.people,
    topSectionId: '',
  }
  return h.div(
    [h.Class('flex min-w-0 flex-col gap-3')],
    [
      h.p(
        [h.Class('text-lg font-bold text-msf-black')],
        [entry.title ?? 'Untitled entry'],
      ),
      ...Array.map(Object.entries(entry.values), ([id, value]) =>
        h.div(
          [h.Class('flex min-w-0 flex-col gap-1')],
          [
            h.p(
              [h.Class('text-base font-medium text-msf-grey')],
              [
                Option.match(findItemAnywhere(state.template, id), {
                  onNone: () => id,
                  onSome: item => item.label,
                }),
              ],
            ),
            valueView(h, findItemAnywhere(state.template, id), value, context),
          ],
        ),
      ),
      ...('sections' in entry
        ? Array.flatMap(Object.entries(entry.sections), ([id, content]) =>
            Option.match(findSection(topLevelSections(state.template), id), {
              onNone: () => [],
              onSome: (section: Section) => [
                h.p([h.Class('text-base font-bold')], [section.title]),
                readOnlySection(h, section, content, context),
              ],
            }),
          )
        : []),
    ],
  )
}

const sideView = <M>(
  h: HtmlBuilder<M>,
  state: ViewState,
  conflict: Conflict,
  which: 'base' | 'ours' | 'theirs',
): Html => {
  const context = {
    reportId: state.reportId,
    people: state.people,
    topSectionId: '',
  }
  switch (conflict.kind) {
    case 'value':
      return valueView(
        h,
        Option.fromNullishOr(lastItemId(conflict.key)).pipe(
          Option.flatMap(id => findItemAnywhere(state.template, id)),
        ),
        conflict[which],
        context,
      )
    case 'entry':
      return entryBox(h, state, conflict[which])
    case 'entry_title':
    case 'person_name':
    case 'person_label': {
      const text = conflict[which]
      return text === undefined || text === ''
        ? h.p([h.Class(muted)], ['Nothing.'])
        : h.p([h.Class('text-lg text-msf-ink')], [text])
    }
    case 'entry_order':
    case 'entries_limit': {
      const ids = conflict[which]
      return ids === undefined
        ? h.p([h.Class(muted)], ['Nothing.'])
        : h.ol(
            [h.Class('list-decimal pl-6 text-lg text-msf-ink')],
            Array.map(ids, id =>
              h.li(
                [],
                [(conflict.titles ?? state.titles)[id] ?? titleOfId(state, id)],
              ),
            ),
          )
    }
    case 'section_status': {
      const status = conflict[which]
      return h.p(
        [h.Class('text-lg text-msf-ink')],
        [
          status === undefined
            ? 'Applicable.'
            : `Not applicable: ${status.reason}`,
        ],
      )
    }
    case 'image_flag': {
      const flag = conflict[which]
      return h.p(
        [h.Class('text-lg text-msf-ink')],
        [
          flag === undefined
            ? 'No flag.'
            : flag
              ? 'Marked safe to share.'
              : 'Not marked safe to share.',
        ],
      )
    }
    case 'person': {
      const person = conflict[which]
      return person === undefined
        ? h.p([h.Class(muted)], ['Not there (deleted).'])
        : h.div(
            [h.Class('flex flex-col gap-1 text-lg text-msf-ink')],
            [
              h.p([], [`${person.name}, shown as ${person.label}`]),
              person.aliases.length === 0
                ? h.empty
                : h.p(
                    [h.Class('text-base text-msf-grey')],
                    [`Also written as: ${person.aliases.join(', ')}`],
                  ),
            ],
          )
    }
  }
}

const sideColumn = <M>(
  h: HtmlBuilder<M>,
  label: string,
  which: string,
  body: Html,
): Html =>
  h.div(
    [
      h.Class('flex min-w-0 flex-col gap-2 border border-msf-line px-3 py-3'),
      h.DataAttribute('side', which),
    ],
    [
      h.p(
        [h.Class('text-sm font-bold uppercase tracking-wide text-msf-grey')],
        [label],
      ),
      body,
    ],
  )

const choiceButton = (
  h: HtmlBuilder<Message>,
  label: string,
  ariaLabel: string,
  isChosen: boolean,
  onClick: Message,
): Html =>
  h.button(
    [
      h.Type('button'),
      h.AriaPressed(isChosen ? 'true' : 'false'),
      h.AriaLabel(ariaLabel),
      h.Class(
        clsx(
          'inline-flex min-h-11 cursor-pointer items-center justify-center border px-3 text-base transition-colors',
          isChosen
            ? 'border-msf-ink bg-msf-ink font-medium text-white'
            : 'border-msf-line text-msf-ink hover:border-msf-red hover:text-msf-red',
          focusRing,
        ),
      ),
      h.OnClick(onClick),
    ],
    [label],
  )

const isRichConflict = (conflict: Conflict): boolean =>
  conflict.kind === 'value' && conflict.richText

const combinedEditor = (
  h: HtmlBuilder<Message>,
  model: Model,
  key: string,
  choice: Extract<Choice, { _tag: 'Edited' }>,
  label: string,
): Html =>
  EditorState.match(model.editor, {
    NotLoaded: () => loadingText(h, 'The text editor opens here.'),
    Loading: () => loadingText(h, 'Loading the text editor.'),
    Failed: () =>
      h.div(
        [h.Class('flex flex-col items-start gap-2')],
        [
          alertText(h, 'The text editor could not be loaded.'),
          actionButton(
            h,
            'Try again',
            'Try loading the text editor again',
            Message.ClickedRetryLoadEditor(),
          ),
        ],
      ),
    Ready: () => {
      const editor = editorElement.withMessage(h)
      return editor([
        h.Id(`combined-${key}`),
        h.DataAttribute('slot', 'combined-rich-text'),
        h.Class('quoroom-editor-box min-w-0'),
        editor.Content(choice.content),
        editor.Version(choice.version),
        editor.Disabled(false),
        editor.Label(label),
        editor.Report(model.reportId),
        editor.Remaining(0),
        editor.OnChange(detail =>
          Message.ChangedCombined({
            key,
            content: detail.content,
            version: detail.version,
          }),
        ),
      ])
    },
  })

const controls = (
  h: HtmlBuilder<Message>,
  model: Model,
  conflict: Conflict,
  label: string,
): Html => {
  const choice = Record.get(model.choices, conflict.key)
  const side = Option.flatMap(choice, found =>
    Choice.guards.Side(found) ? Option.some(found.side) : Option.none(),
  )
  const isClash = conflict.kind === 'person_label' && conflict.clash
  return h.div(
    [h.Class('flex flex-col gap-3')],
    [
      h.div(
        [
          h.Class('flex flex-wrap gap-2'),
          h.Role('group'),
          h.AriaLabel(`Choose for ${label}`),
        ],
        [
          isClash
            ? h.empty
            : choiceButton(
                h,
                'Keep mine',
                `Keep my version of ${label}`,
                Option.exists(side, chosen => chosen === 'ours'),
                Message.ChoseSide({ key: conflict.key, side: 'ours' }),
              ),
          isClash
            ? h.empty
            : choiceButton(
                h,
                'Keep theirs',
                `Keep their version of ${label}`,
                Option.exists(side, chosen => chosen === 'theirs'),
                Message.ChoseSide({ key: conflict.key, side: 'theirs' }),
              ),
          isRichConflict(conflict)
            ? choiceButton(
                h,
                'Edit a combined version',
                `Edit a combined version of ${label}`,
                Option.exists(choice, Choice.guards.Edited),
                Message.ChoseCombined({ key: conflict.key }),
              )
            : h.empty,
          conflict.kind === 'person_label'
            ? choiceButton(
                h,
                'Type a new label',
                `Type a new label for ${label}`,
                Option.exists(choice, Choice.guards.Label),
                Message.ChoseLabel({ key: conflict.key }),
              )
            : h.empty,
          conflict.kind === 'entries_limit'
            ? choiceButton(
                h,
                'Choose which to keep',
                `Choose which entries to keep for ${label}`,
                Option.exists(choice, Choice.guards.Keep),
                Message.ChoseKeep({ key: conflict.key }),
              )
            : h.empty,
        ],
      ),
      Option.match(choice, {
        onNone: () =>
          h.p([h.Class('text-base text-msf-grey')], ['Not chosen yet.']),
        onSome: found =>
          Choice.match(found, {
            Side: ({ side: chosen }) =>
              h.p(
                [h.Class('text-base font-medium text-msf-ink')],
                [chosen === 'ours' ? 'Chosen: mine.' : 'Chosen: theirs.'],
              ),
            Edited: edited =>
              h.div(
                [h.Class('flex flex-col gap-2')],
                [
                  h.p(
                    [h.Class('text-base font-medium text-msf-ink')],
                    ['Chosen: the combined version below.'],
                  ),
                  combinedEditor(h, model, conflict.key, edited, label),
                ],
              ),
            Label: ({ text }) =>
              h.div(
                [h.Class('flex max-w-md flex-col gap-1')],
                [
                  h.label(
                    [
                      h.Class('text-base font-medium text-msf-ink'),
                      h.For(`label-${conflict.key}`),
                    ],
                    [`New label for ${label}`],
                  ),
                  h.input([
                    h.Id(`label-${conflict.key}`),
                    h.Type('text'),
                    h.Value(text),
                    h.Autocomplete('off'),
                    h.Class(
                      clsx(
                        'h-12 w-full border border-msf-line bg-white px-3 text-lg',
                        focusRing,
                      ),
                    ),
                    h.OnInput(value =>
                      Message.TypedLabel({ key: conflict.key, text: value }),
                    ),
                  ]),
                ],
              ),
            Keep: ({ ids }) =>
              conflict.kind === 'entries_limit'
                ? h.div(
                    [h.Class('flex flex-col gap-2')],
                    [
                      h.p(
                        [
                          h.Class(
                            clsx(
                              'text-base font-medium',
                              ids.length > conflict.max
                                ? 'text-msf-alert'
                                : 'text-msf-ink',
                            ),
                          ),
                        ],
                        [
                          `Keep at most ${conflict.max}. Chosen: ${ids.length}.`,
                        ],
                      ),
                      ...Array.map(conflict.merged, id =>
                        h.label(
                          [
                            h.Class(
                              'flex min-h-11 cursor-pointer items-center gap-3 text-lg',
                            ),
                          ],
                          [
                            h.input([
                              h.Type('checkbox'),
                              h.Class('size-5 accent-msf-red'),
                              h.Checked(Array.contains(ids, id)),
                              h.OnClick(
                                Message.ToggledKeep({ key: conflict.key, id }),
                              ),
                            ]),
                            (conflict.titles ?? modelTitles(model))[id] ??
                              'An entry',
                          ],
                        ),
                      ),
                    ],
                  )
                : h.empty,
          }),
      }),
    ],
  )
}

const modelTitles = (model: Model): Readonly<Record<string, string>> =>
  Option.match(model.maybeComparison, {
    onNone: () => ({}),
    onSome: entryTitles,
  })

const kindNote = (conflict: Conflict): string => {
  if (conflict.kind === 'person_label' && conflict.clash) {
    return 'Two people now have the same label, or a label that is also a written form of another person. Type a new one.'
  }
  if (conflict.kind === 'entries_limit') {
    return 'Together you added more entries than are allowed. Choose which to keep.'
  }
  if (conflict.kind === 'entry') {
    return 'One of you deleted this entry and the other changed it.'
  }
  return 'Both of you changed this.'
}

const conflictCard = (
  h: HtmlBuilder<Message>,
  model: Model,
  state: ViewState,
  comparison: Comparison,
  conflict: Conflict,
  index: number,
): Html => {
  const label = keyLabel(
    state.template,
    conflict.key,
    state.titles,
    state.people,
  )
  return h.keyed('section')(
    conflict.key,
    [
      h.AriaLabel(`Conflict ${index + 1}: ${label}`),
      h.DataAttribute('conflict', conflict.key),
      h.Class('flex flex-col gap-4 border-2 border-msf-ink px-3 py-4 sm:px-4'),
    ],
    [
      h.h3([h.Class('text-xl font-black text-msf-black')], [label]),
      h.p([h.Class('text-base text-msf-grey')], [kindNote(conflict)]),
      h.div(
        [h.Class('grid min-w-0 grid-cols-1 gap-3 md:grid-cols-3')],
        [
          sideColumn(
            h,
            `Where you started (${draftLabel(comparison.baseDraft)})`,
            'base',
            sideView(h, state, conflict, 'base'),
          ),
          sideColumn(
            h,
            'Mine (your working copy)',
            'ours',
            sideView(h, state, conflict, 'ours'),
          ),
          sideColumn(
            h,
            `Theirs (${draftLabel(comparison.theirsDraft)})`,
            'theirs',
            sideView(h, state, conflict, 'theirs'),
          ),
        ],
      ),
      controls(h, model, conflict, label),
    ],
  )
}

const WHO = { ours: 'You', theirs: 'The other author', both: 'Both of you' }
const VERB = { added: 'added', removed: 'removed', changed: 'changed' }

export const omittedText = (omitted: number): string =>
  `and ${omitted} more ${omitted === 1 ? 'change' : 'changes'}`

const omittedChanges = (
  h: HtmlBuilder<Message>,
  comparison: Comparison,
): ReadonlyArray<Html> =>
  (comparison.automaticOmitted ?? 0) > 0
    ? [
        h.li(
          [
            h.Class('py-3 text-lg text-msf-grey'),
            h.DataAttribute('automatic', 'omitted'),
          ],
          [omittedText(comparison.automaticOmitted ?? 0)],
        ),
      ]
    : []

const automaticPanel = (
  h: HtmlBuilder<Message>,
  state: ViewState,
  comparison: Comparison,
): Html => {
  const changes = comparison.automatic ?? []
  return panel(
    h,
    'Taken automatically',
    [
      Array.match(changes, {
        onEmpty: () =>
          h.p(
            [h.Class('text-lg text-msf-grey')],
            ['Nothing else changed on either side.'],
          ),
        onNonEmpty: list =>
          h.ul(
            [
              h.AriaLabel('Changes taken automatically'),
              h.Class(
                'flex flex-col divide-y divide-msf-line border-y border-msf-line',
              ),
            ],
            [
              ...Array.map(list, change =>
                h.keyed('li')(
                  change.key,
                  [
                    h.Class('py-3 text-lg text-msf-ink'),
                    h.DataAttribute('automatic', change.side),
                  ],
                  [
                    `${WHO[change.side]} ${VERB[change.change]} ${keyLabel(state.template, change.key, state.titles, state.people)}`,
                  ],
                ),
              ),
              ...omittedChanges(h, comparison),
            ],
          ),
      }),
    ],
    Option.some(
      'Only one of you changed these, or you both made the same change. They are in the draft without a choice.',
    ),
  )
}

const comparisonView = (
  h: HtmlBuilder<Message>,
  model: Model,
  state: ViewState,
  comparison: Comparison,
  copy: CopyOutline,
  isBusy: boolean,
): Html =>
  h.div(
    [h.Class('flex flex-col gap-8')],
    [
      h.p(
        [h.Class('text-pretty text-lg text-msf-ink')],
        [
          `Your working copy started from ${draftLabel(comparison.baseDraft)}. ${draftLabel(comparison.theirsDraft)} was shared since. ${
            comparison.conflicts.length === 0
              ? 'Nothing needs a choice.'
              : `${comparison.conflicts.length} ${comparison.conflicts.length === 1 ? 'item needs' : 'items need'} a choice.`
          }`,
        ],
      ),
      Option.match(model.maybeNotice, {
        onNone: () => h.empty,
        onSome: notice => statusText(h, notice),
      }),
      automaticPanel(h, state, comparison),
      ...(comparison.conflicts.length === 0
        ? []
        : [
            panel(
              h,
              'Choose what to keep',
              Array.map(comparison.conflicts, (conflict, index) =>
                conflictCard(h, model, state, comparison, conflict, index),
              ),
            ),
          ]),
      h.button(
        [
          h.Type('button'),
          h.Disabled(isBusy),
          h.Class(
            clsx(
              'inline-flex min-h-12 cursor-pointer items-center justify-center self-start bg-msf-red px-6 text-lg font-medium text-white transition-colors hover:bg-msf-black disabled:cursor-wait disabled:opacity-70',
              focusRing,
            ),
          ),
          h.OnClick(Message.ClickedResolve()),
        ],
        [
          isBusy
            ? 'Combining…'
            : `Resolve and review ${draftLabel(copy.latestDraft + 1)}`,
        ],
      ),
    ],
  )

const progressView = (
  h: HtmlBuilder<Message>,
  model: Model,
  copy: CopyOutline,
) =>
  Phase.match(model.phase, {
    Ready: () => h.empty,
    Comparing: () => h.empty,
    Resolving: () => h.empty,
    Shared: () => h.empty,
    Staging: ({ next }) =>
      statusText(
        h,
        `Sharing section ${Math.min(next + 1, copy.sectionIds.length)} of ${copy.sectionIds.length}.`,
      ),
    Finishing: () => statusText(h, 'Finishing the share.'),
    Failed: ({ failure, next, needsReload }) =>
      needsReload
        ? h.div(
            [h.Class('flex flex-col items-start gap-3')],
            [
              alertText(h, failureText(failure)),
              h.p(
                [h.Class('text-base text-msf-grey')],
                [
                  'The working copy or the shared drafts changed while you were sharing, so continuing would fail again. Nothing was shared. Load it again and share from there.',
                ],
              ),
              actionButton(
                h,
                'Reload and share again',
                'Reload the working copy and share again',
                Message.ClickedReloadShare(),
              ),
            ],
          )
        : h.div(
            [h.Class('flex flex-col items-start gap-3')],
            [
              alertText(h, failureText(failure)),
              h.p(
                [h.Class('text-base text-msf-grey')],
                [
                  next >= copy.sectionIds.length
                    ? 'Every section was sent. Only the last step is left.'
                    : `Sharing stopped at section ${next + 1} of ${copy.sectionIds.length}. What was already sent is kept.`,
                ],
              ),
              actionButton(
                h,
                'Continue sharing',
                'Continue sharing from where it stopped',
                Message.ClickedResume(),
              ),
            ],
          ),
  })

const shell = (
  h: HtmlBuilder<Message>,
  model: Model,
  children: ReadonlyArray<Html>,
  title = 'Share a draft',
): Html =>
  h.section(
    [
      h.AriaLabel('Share a draft'),
      h.Class('flex max-w-5xl flex-col gap-6 pb-14 pt-10 md:pt-14'),
    ],
    [
      h.a(
        [
          h.Href(pathOf(AppRoute.Report({ reportId: model.reportId }))),
          h.Class(
            clsx('self-start text-base text-msf-ink underline', focusRing),
          ),
        ],
        ['Back to the report'],
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

// NOTE: "Share and publish": one step that shares the working copy as the
// next draft and publishes it. It goes through the preview and the
// confirmation of this screen like any share; the terms are the ones of the
// publishing screen (`publishForm.ts`).
const publishSection = (
  h: HtmlBuilder<Message>,
  model: Model,
  context: PublishForm.FormContext,
): Html =>
  h.section(
    [
      h.AriaLabel('Publish for review'),
      h.Class('flex min-w-0 flex-col gap-4 border-t-2 border-msf-ink pt-5'),
    ],
    [
      h.h2(
        [h.Class('text-2xl font-black tracking-tight')],
        ['Publish for review as well'],
      ),
      checkboxField(
        h,
        'share-and-publish',
        'Publish this draft for review as soon as it is shared',
        model.wantsPublish,
        Message.ToggledPublish(),
        Option.some(
          'Reviewers of a redacted role only receive the redacted version you confirm here.',
        ),
      ),
      model.wantsPublish
        ? PublishForm.view(h, model.publishForm, context, message =>
            Message.GotPublishFormMessage({ message }),
          )
        : h.empty,
    ],
  )

const publishPanel = (h: HtmlBuilder<Message>, model: Model): Html =>
  Option.match(publishContextOf(model), {
    onNone: () => h.empty,
    onSome: context =>
      Array.match(context.choices.roles, {
        onEmpty: () => h.empty,
        onNonEmpty: () => publishSection(h, model, context),
      }),
  })

// NOTE: The preview before the share (D14): the author reads the text the
// reviewers of a redacted role will get, every replacement highlighted, and
// confirms exactly that. The browser compares what the server staged with what
// it showed and sends the hash of it with `FinishShare`.
const readyView = (
  h: HtmlBuilder<Message>,
  model: Model,
  template: Template,
  next: string,
): Html => {
  const problems = peopleProblemCount(model)
  const caseTitle = Option.match(model.maybeDetail, {
    onNone: () => '',
    onSome: detail => detail.summary.caseFile.title,
  })
  return h.div(
    [h.Class('flex min-w-0 flex-col gap-6')],
    [
      h.section(
        [
          h.AriaLabel('Preview of what will be shared'),
          h.Class('flex min-w-0 flex-col gap-4 border-t-2 border-msf-ink pt-5'),
        ],
        [
          h.h2(
            [h.Class('text-2xl font-black tracking-tight')],
            ['Check the redacted version'],
          ),
          h.p(
            [h.Class('text-base text-msf-grey')],
            [
              `${model.people.length === 0 ? 'The people list is empty, so no name is replaced. ' : ''}${viewNote(model.view)}`,
            ],
          ),
          viewToggle(h, model.view, view => Message.ChoseView({ view })),
          previewAll(
            h,
            {
              template,
              people: model.people,
              contents: model.contents,
              reportId: model.reportId,
              caseTitle,
            },
            model.view,
          ),
        ],
      ),
      h.a(
        [
          h.Href(pathOf(AppRoute.Names({ reportId: model.reportId }))),
          h.Class(clsx('self-start text-lg text-msf-ink underline', focusRing)),
        ],
        ['People, names and pictures'],
      ),
      problems > 0
        ? alertText(
            h,
            'The list of people has a problem (a repeated label, or a label that holds a name). Fix it before sharing.',
          )
        : h.empty,
      publishPanel(h, model),
      ...Array.map(model.publishProblems, problem => alertText(h, problem)),
      h.button(
        [
          h.Type('button'),
          h.Disabled(problems > 0),
          h.Class(
            clsx(
              'inline-flex min-h-12 cursor-pointer items-center justify-center self-start bg-msf-red px-6 text-lg font-medium text-white transition-colors hover:bg-msf-black disabled:cursor-not-allowed disabled:opacity-50',
              focusRing,
            ),
          ),
          h.OnClick(Message.ClickedShare()),
        ],
        [
          model.wantsPublish
            ? `Confirm the redacted version, share as ${next} and publish`
            : `Confirm the redacted version and share as ${next}`,
        ],
      ),
      h.p(
        [h.Class('max-w-prose text-base text-msf-grey')],
        [
          'Sharing confirms that you read the redacted version above. Reviewers of a redacted role only ever receive that text.',
        ],
      ),
    ],
  )
}

const loadedView = (
  h: HtmlBuilder<Message>,
  model: Model,
  template: Template,
  copy: CopyOutline,
): Html => {
  const comparison = Option.getOrUndefined(model.maybeComparison)
  const state: ViewState = {
    template,
    people: model.people,
    reportId: model.reportId,
    titles: comparison === undefined ? {} : entryTitles(comparison),
  }
  const next = draftLabel(copy.latestDraft + 1)
  return Phase.match(model.phase, {
    Shared: ({ draft, maybeRevision }) =>
      shell(
        h,
        model,
        [
          h.p(
            [
              h.Role('status'),
              h.DataAttribute('shared', String(draft)),
              h.Class('text-2xl font-black text-msf-black'),
            ],
            [`Shared as ${draftLabel(draft)}.`],
          ),
          Option.match(maybeRevision, {
            onNone: () => h.empty,
            onSome: revision =>
              h.div(
                [h.Class('flex flex-col gap-2')],
                [
                  h.p(
                    [
                      h.Role('status'),
                      h.DataAttribute('published', String(revision)),
                      h.Class('text-2xl font-black text-msf-black'),
                    ],
                    [`Published as Revision ${revision}.`],
                  ),
                  h.a(
                    [
                      h.Href(
                        pathOf(AppRoute.Publish({ reportId: model.reportId })),
                      ),
                      h.Class(
                        clsx(
                          'self-start text-lg text-msf-ink underline',
                          focusRing,
                        ),
                      ),
                    ],
                    ['Review round and deadline'],
                  ),
                ],
              ),
          }),
          h.p(
            [h.Class('text-lg text-msf-ink')],
            [
              'The other authors see it in the history. A shared draft never changes.',
            ],
          ),
          h.div(
            [h.Class('flex flex-wrap gap-4')],
            [
              h.a(
                [
                  h.Href(
                    pathOf(AppRoute.Draft({ reportId: model.reportId, draft })),
                  ),
                  h.Class(clsx('text-lg text-msf-ink underline', focusRing)),
                ],
                [`Read ${draftLabel(draft)}`],
              ),
              h.a(
                [
                  h.Href(pathOf(AppRoute.Drafts({ reportId: model.reportId }))),
                  h.Class(clsx('text-lg text-msf-ink underline', focusRing)),
                ],
                ['Draft history'],
              ),
            ],
          ),
        ],
        'Shared',
      ),
    Comparing: () =>
      comparison === undefined
        ? shell(h, model, [loadingText(h, 'Comparing.')])
        : shell(
            h,
            model,
            [comparisonView(h, model, state, comparison, copy, false)],
            `Compare with ${draftLabel(comparison.theirsDraft)}`,
          ),
    Resolving: () =>
      comparison === undefined
        ? shell(h, model, [loadingText(h, 'Combining.')])
        : shell(
            h,
            model,
            [comparisonView(h, model, state, comparison, copy, true)],
            `Compare with ${draftLabel(comparison.theirsDraft)}`,
          ),
    Ready: () =>
      shell(h, model, [
        h.p(
          [h.Class('text-pretty text-lg text-msf-ink')],
          [
            `Your working copy started from ${draftLabel(copy.baseDraft)}. Sharing it makes ${next}, which the other authors can read. A shared draft never changes afterwards.`,
          ],
        ),
        canShare(model)
          ? readyView(h, model, template, next)
          : h.p(
              [h.Role('status'), h.Class('text-lg text-msf-grey')],
              ['There is nothing new to share.'],
            ),
      ]),
    Staging: () => shell(h, model, [progressView(h, model, copy)]),
    Finishing: () => shell(h, model, [progressView(h, model, copy)]),
    Failed: () => shell(h, model, [progressView(h, model, copy)]),
  })
}

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
          template: model.maybeTemplate,
          copy: model.maybeCopy,
        }),
        {
          onNone: () => shell(h, model, [loadingText(h, 'Loading.')]),
          onSome: ({ template, copy }) => loadedView(h, model, template, copy),
        },
      ),
  }),
)
