import { clsx } from 'clsx'
import {
  Array,
  Clock,
  Crypto,
  Duration,
  Effect,
  Option,
  Order,
  Record,
  Result,
  Schema,
  Stream,
} from 'effect'
import { Command, Dom, Submodel, Subscription, Update } from 'foldkit'
import { Html, HtmlBuilder } from 'foldkit/html'
import { defineMessageUnion } from 'foldkit/message'
import { defineTaggedUnion } from 'foldkit/schema'
import { modifyFields } from 'foldkit/struct'

import {
  AccountRef,
  CONTENT_SCHEMA_VERSION,
  DraftingInfo,
  type EndState,
  type ItemStep,
  ItemValue,
  type NumberedSection,
  PeopleList,
  type Permission,
  ReportDetail,
  type ReportState,
  RevisionHeader,
  Section,
  SectionContent,
  type SectionContents,
  type SectionState,
  Template,
  UnitMember,
  canAdd,
  childKeyOf,
  contentOfKey,
  contentTexts,
  countText,
  endState,
  entriesOfKey,
  entryDisplayTitle,
  entryKeyOf,
  groupKeyOf,
  notApplicableReasonOf,
  numberSections,
  parentKeyOf,
  sectionLimits,
  sectionOfKey,
  sectionStates,
  topSectionIdOfKey,
  withItemValueAt,
} from '@case-desk/domain'
import { BrowserCrypto } from '@effect/platform-browser'

import { AppRoute, pathOf } from '../route'
import { focusRing } from '../style'
import { type QuoroomClient, withQuoroom } from './api'
import { timeText } from './draftText'
import {
  EMPTY_RICH_TEXT_JSON,
  parseRichTextJson,
  serializeRichText,
} from './editor/richText'
import {
  EDITOR_FINAL_EVENT,
  EDITOR_UPLOAD_CANCELLED_EVENT,
} from './editor/spec'
import { EditorState, RichTextSelection, editorKey } from './editor/state'
import {
  StepSchema,
  Target,
  addEntryTo,
  addRefusal,
  clearNotApplicable,
  itemTarget,
  markNotApplicable,
  moveEntryIn,
  removeEntryFrom,
  retitleEntryIn,
  sameContent,
  sectionTarget,
  targetId,
  valueOf,
} from './entryEdit'
import {
  actionButton,
  addButton,
  countLine,
  entryControls,
  notApplicableButton,
  notApplicableForm,
  notApplicableNotice,
} from './entryViews'
import { Failure, failureOf, failureText, isStaleSave } from './failure'
import { type CaseValues, type FieldContext, itemField } from './fields'
import { FormState, formStatus, isSubmitting } from './formState'
import { IMAGE_LIMITS_TEXT, remainingBytes, usageText } from './images/plan'
import {
  PreviewView,
  previewSection,
  viewNote,
  viewToggle,
} from './redactedView'
import { outcomeOf, outcomeView } from './roundOutcome'
import { currentRoundOf, revisionsList, roundLine } from './rounds'
import { PageScope, isCurrentPage } from './scope'
import {
  failureAlert,
  loadingText,
  panel,
  selectField,
  smallButton,
  statusText,
  submitButton,
  textField,
} from './ui'
import { LoadState } from './unit'

// NOTE: The drafting screen (stage 4b), at `/r/:id`. An author works on their
// own working copy, one top-level section at a time (`SaveSection`): a change
// to any field saves its section, one save at a time, because the working copy
// has one save counter and a second request with an old counter is refused.
// The navigator, the numbers and the states come from the domain
// (`numberSections`, `sectionStates`, `endState`) and are recomputed from the
// content on every change, so a branch that ends the report, and the answer
// that restores it, show at once.
//
// Rich text is edited in the editor element (stage 4c), loaded lazily the
// first time a section with a rich-text item is shown. Its changes arrive as
// canonical JSON text with a version, are decoded again here, and are saved
// through the same per-section save as every other item.
//
// Stage 4e: repeatable subsections and repeated items are edited here (add,
// remove after a confirmation, reorder, an author title for a subsection,
// limits with messages), and an item or a section that is optional with a
// reason can be marked not applicable, with its reason.
//
// Stage 4f: saving is a small state machine shown to the author: Saving,
// Saved at a time, Not saved and retrying, Offline, and Stale. A save carries
// the working copy's save counter; if the same author's other tab saved first
// the server refuses it, nothing is overwritten, the local edit stays on this
// page, and the author reloads the saved version and may put the kept edit
// back. A page with unsaved edits asks before it is left.

export const SECTION_HEADING_ID = 'section-heading'
export const CONFIRMATION_ID = 'confirmation-heading'

// MODEL

export const SaveStatus = defineTaggedUnion({
  Saved: {},
  Saving: { sectionId: Schema.String },
  Failed: { failure: Failure },
  Stale: { sectionId: Schema.String },
})
export type SaveStatus = typeof SaveStatus.Type

// NOTE: What the server says the report's images use (`ListImages`), shown
// above the editor and used to refuse a picture that cannot fit.
export const ImageUsage = Schema.Struct({
  usedBytes: Schema.Int,
  limitBytes: Schema.Int,
})

// NOTE: What the server says about the author's working copy.
export const CopyInfo = Schema.Struct({
  baseDraft: Schema.Int,
  latestDraft: Schema.Int,
  behind: Schema.Boolean,
  hasUnsharedChanges: Schema.Boolean,
})
export type CopyInfo = typeof CopyInfo.Type

// NOTE: An edit that could not be saved because the working copy changed in
// another tab, kept so it can be copied or put back.
export const KeptEdit = Schema.Struct({
  sectionId: Schema.String,
  content: SectionContent,
})

// NOTE: The page a Command was started for, and the working copy it was
// started against. `epoch` is raised every time the working copy is replaced
// (reloaded, started again), so a save started before is never taken for one
// of the new working copy.
export const Scope = Schema.Struct({
  ...PageScope.fields,
  epoch: Schema.Int,
})
export type Scope = typeof Scope.Type

export const NaDraft = Schema.Struct({
  reason: Schema.String,
  isMissing: Schema.Boolean,
})

export const Confirmation = defineTaggedUnion({
  RemoveEntry: {
    target: Target,
    entryId: Schema.String,
    label: Schema.String,
  },
  ReplaceCopy: {},
  StartConclusion: {},
  ReapplyEdit: { sectionId: Schema.String, title: Schema.String },
})
export type Confirmation = typeof Confirmation.Type

export const Model = Schema.Struct({
  origin: Schema.String,
  reportId: Schema.String,
  generation: Schema.Int,
  epoch: Schema.Int,
  load: LoadState,
  maybeDetail: Schema.Option(ReportDetail),
  maybeTemplate: Schema.Option(Template),
  unitName: Schema.String,
  contents: Schema.Record(Schema.String, SectionContent),
  people: PeopleList,
  saveCounter: Schema.Int,
  save: SaveStatus,
  dirtySectionIds: Schema.Array(Schema.String),
  maybeSelectedKey: Schema.Option(Schema.String),
  isNavigatorOpen: Schema.Boolean,
  view: PreviewView,
  unitMembers: Schema.Array(UnitMember),
  coAuthorChoice: Schema.String,
  coAuthorForm: FormState,
  maybeNotice: Schema.Option(Schema.String),
  editor: EditorState,
  editorVersions: Schema.Record(Schema.String, Schema.Int),
  maybeSelection: Schema.Option(RichTextSelection),
  maybeRefusal: Schema.Option(Schema.String),
  maybeImageUsage: Schema.Option(ImageUsage),
  maybeSavedAt: Schema.Option(Schema.Int),
  isOnline: Schema.Boolean,
  isReloading: Schema.Boolean,
  keptEdits: Schema.Array(KeptEdit),
  maybeCopy: Schema.Option(CopyInfo),
  maybeConfirmation: Schema.Option(Confirmation),
  naDrafts: Schema.Record(Schema.String, NaDraft),
  naStash: Schema.Record(Schema.String, ItemValue),
  titleDrafts: Schema.Record(Schema.String, Schema.String),
  maybeEditNote: Schema.Option(Schema.String),
  editorGeneration: Schema.Int,
  myId: Schema.String,
  drafting: Schema.Array(DraftingInfo),
  revisions: Schema.Array(RevisionHeader),
  nowMs: Schema.Int,
})
export type Model = typeof Model.Type

export const initialModel = Model.make({
  origin: '',
  reportId: '',
  generation: 0,
  epoch: 0,
  load: LoadState.Loading(),
  maybeDetail: Option.none(),
  maybeTemplate: Option.none(),
  unitName: '',
  contents: {},
  people: [],
  saveCounter: 0,
  save: SaveStatus.Saved(),
  dirtySectionIds: [],
  maybeSelectedKey: Option.none(),
  isNavigatorOpen: false,
  view: 'original',
  unitMembers: [],
  coAuthorChoice: '',
  coAuthorForm: FormState.Editing(),
  maybeNotice: Option.none(),
  editor: EditorState.NotLoaded(),
  editorVersions: {},
  maybeSelection: Option.none(),
  maybeRefusal: Option.none(),
  maybeImageUsage: Option.none(),
  maybeSavedAt: Option.none(),
  isOnline: true,
  isReloading: false,
  keptEdits: [],
  maybeCopy: Option.none(),
  maybeConfirmation: Option.none(),
  naDrafts: {},
  naStash: {},
  titleDrafts: {},
  maybeEditNote: Option.none(),
  editorGeneration: 0,
  myId: '',
  drafting: [],
  revisions: [],
  nowMs: 0,
})

export const LoadedReport = Schema.Struct({
  detail: ReportDetail,
  template: Template,
  unitName: Schema.String,
  contents: Schema.Record(Schema.String, SectionContent),
  people: PeopleList,
  saveCounter: Schema.Int,
  unitMembers: Schema.Array(UnitMember),
  maybeImageUsage: Schema.Option(ImageUsage),
  savedAt: Schema.Int,
  copy: CopyInfo,
  myId: Schema.String,
  drafting: Schema.Array(DraftingInfo),
  revisions: Schema.Array(RevisionHeader),
  nowMs: Schema.Int,
})
export type LoadedReport = typeof LoadedReport.Type

// MESSAGE

export const Message = defineMessageUnion({
  SucceededLoadReport: { scope: Scope, loaded: LoadedReport },
  FailedLoadReport: { scope: Scope, failure: Failure },
  ClickedRetryLoad: {},
  SelectedSection: { key: Schema.String },
  ToggledNavigator: {},
  ChoseView: { view: PreviewView },
  ChangedItem: {
    sectionKey: Schema.String,
    steps: Schema.Array(StepSchema),
    itemId: Schema.String,
    maybeValue: Schema.Option(ItemValue),
  },
  SucceededSaveSection: {
    scope: Scope,
    sectionId: Schema.String,
    saveCounter: Schema.Int,
    savedAt: Schema.Int,
  },
  FailedSaveSection: {
    scope: Scope,
    sectionId: Schema.String,
    failure: Failure,
  },
  StaleSaveSection: {
    scope: Scope,
    sectionId: Schema.String,
    sent: SectionContent,
  },
  SucceededReadStaleSection: {
    scope: Scope,
    sectionId: Schema.String,
    sent: SectionContent,
    saved: SectionContent,
    saveCounter: Schema.Int,
    savedAt: Schema.Int,
  },
  FailedReadStaleSection: {
    scope: Scope,
    sectionId: Schema.String,
    failure: Failure,
  },
  ClickedRetrySave: {},
  TickedSaveRetry: {},
  ChangedConnection: { isOnline: Schema.Boolean },
  WarnedBeforeLeaving: {},
  ClickedReloadWorkingCopy: {},
  SucceededReloadWorkingCopy: {
    scope: Scope,
    contents: Schema.Record(Schema.String, SectionContent),
    saveCounter: Schema.Int,
    savedAt: Schema.Int,
    copy: CopyInfo,
  },
  FailedReloadWorkingCopy: { scope: Scope, failure: Failure },
  ClickedReapplyEdit: { sectionId: Schema.String },
  ClickedDiscardEdit: { sectionId: Schema.String },
  ConfirmedReapplyEdit: {},
  ClickedReplaceCopy: {},
  ConfirmedReplaceCopy: {},
  SucceededReplaceCopy: { scope: Scope },
  FailedReplaceCopy: { scope: Scope, failure: Failure },
  CancelledConfirmation: {},
  CompletedFocusConfirmation: {},
  ClickedAddEntry: { target: Target },
  GeneratedEntryId: { scope: Scope, target: Target, entryId: Schema.String },
  ClickedMoveEntry: {
    target: Target,
    entryId: Schema.String,
    step: Schema.Int,
  },
  ClickedRemoveEntry: {
    target: Target,
    entryId: Schema.String,
    label: Schema.String,
  },
  ConfirmedRemoveEntry: {},
  ChangedEntryTitle: {
    target: Target,
    entryId: Schema.String,
    text: Schema.String,
  },
  OpenedNotApplicable: { target: Target, reason: Schema.String },
  TypedNotApplicableReason: { target: Target, text: Schema.String },
  SubmittedNotApplicable: { target: Target },
  CancelledNotApplicable: { target: Target },
  RestoredApplicable: { target: Target },
  SelectedCoAuthor: { value: Schema.String },
  SubmittedCoAuthor: {},
  SucceededAddCoAuthor: { scope: Scope, account: AccountRef },
  FailedAddCoAuthor: { scope: Scope, failure: Failure },
  CompletedFocusSectionHeading: {},
  SucceededLoadEditor: {},
  FailedLoadEditor: {},
  ClickedRetryLoadEditor: {},
  ChangedRichText: {
    sectionKey: Schema.String,
    steps: Schema.Array(StepSchema),
    itemId: Schema.String,
    content: Schema.String,
    version: Schema.Int,
  },
  FlushedRichText: {
    scope: Scope,
    sectionKey: Schema.String,
    steps: Schema.Array(StepSchema),
    itemId: Schema.String,
    content: Schema.String,
    version: Schema.Int,
  },
  DiscardedRichText: {
    sectionKey: Schema.String,
    steps: Schema.Array(StepSchema),
    itemId: Schema.String,
    content: Schema.String,
  },
  CancelledImageUpload: { scope: Scope },
  AddedImage: {},
  SucceededLoadImageUsage: { scope: Scope, usage: ImageUsage },
  FailedLoadImageUsage: { scope: Scope },
  SucceededRefreshDrafting: {
    scope: Scope,
    drafting: Schema.Array(DraftingInfo),
  },
  TickedDraftingRefresh: {},
  TickedRoundClock: { nowMs: Schema.Int },
  ClickedStartConclusion: {},
  ConfirmedStartConclusion: {},
  SucceededStartConclusion: { scope: Scope },
  FailedStartConclusion: { scope: Scope, failure: Failure },
  FailedRefreshRounds: { scope: Scope },
  SucceededRefreshRounds: {
    scope: Scope,
    detail: ReportDetail,
    revisions: Schema.Array(RevisionHeader),
  },
  SelectedRichTextRange: {
    sectionKey: Schema.String,
    itemId: Schema.String,
    from: Schema.Number,
    to: Schema.Number,
    text: Schema.String,
  },
})
export type Message = typeof Message.Type

// COMMAND

const topLevelSections = (template: Template): ReadonlyArray<Section> =>
  template.conclusion === undefined
    ? template.sections
    : [...template.sections, template.conclusion]

const hasContent = (content: SectionContent): boolean =>
  Object.keys(content.values).length > 0 ||
  Object.keys(content.sections).length > 0 ||
  content.notApplicable !== undefined ||
  content.entries !== undefined

const copyInfoOf = (outline: {
  baseDraft: number
  latestDraft: number
  behind: boolean
  hasUnsharedChanges: boolean
}): CopyInfo => ({
  baseDraft: outline.baseDraft,
  latestDraft: outline.latestDraft,
  behind: outline.behind,
  hasUnsharedChanges: outline.hasUnsharedChanges,
})

// NOTE: Reads every top-level section of the author's working copy (a few at
// a time) with the counter the server holds now.
const readWorkingCopy = (
  client: QuoroomClient,
  reportId: string,
  sectionIds: ReadonlyArray<string>,
) =>
  Effect.gen(function* () {
    const outline = yield* client.GetWorkingCopy({ reportId })
    const sections = yield* Effect.forEach(
      sectionIds,
      sectionId => client.GetWorkingCopySection({ reportId, sectionId }),
      { concurrency: 4 },
    )
    return {
      contents: Object.fromEntries(
        sections
          .filter(section => hasContent(section.content))
          .map(section => [section.sectionId, section.content]),
      ),
      saveCounter: outline.saveCounter,
      savedAt: outline.savedAt,
      copy: copyInfoOf(outline),
      ownerId: outline.ownerId,
    }
  })

// NOTE: An archived report is read from the latest revision's draft, never
// from the private working copy: any co-author can open it, with or without a
// working copy of their own (the server refuses to start one on an archived
// report, and a read of a copy that was never started finds nothing).
const readLatestDraft = (
  client: QuoroomClient,
  reportId: string,
  sectionIds: ReadonlyArray<string>,
  draft: number,
) =>
  Effect.gen(function* () {
    const outline = yield* client.GetDraftOutline({ reportId, draft })
    const sections = yield* Effect.forEach(
      sectionIds,
      sectionId =>
        client.GetDraftSection({
          reportId,
          draft,
          sectionId,
          view: 'original',
        }),
      { concurrency: 4 },
    )
    const people = yield* client.GetPeople({ reportId, draft })
    const me = yield* client.GetMe()
    return {
      contents: Object.fromEntries(
        sections
          .filter(section => hasContent(section.content))
          .map(section => [section.sectionId, section.content]),
      ),
      saveCounter: 0,
      savedAt: outline.header.sharedAt,
      copy: {
        baseDraft: draft,
        latestDraft: draft,
        behind: false,
        hasUnsharedChanges: false,
      },
      ownerId: me.id,
      people: people.people,
    }
  })

export const LoadReport = Command.define('LoadReport', {
  args: { scope: Scope },
  messages: [Message.SucceededLoadReport, Message.FailedLoadReport],
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
        const template = version.template
        const sectionIds = Array.map(
          topLevelSections(template),
          section => section.id,
        )
        const isArchived = detail.summary.state === 'archived'
        // NOTE: the history is needed to find the closing revision's draft of
        // an archived report, so its failure is not swallowed there.
        const archivedHistory = isArchived
          ? yield* client.GetHistory({ reportId })
          : { drafts: [], revisions: [] }
        const closing = Array.last(
          Array.sort(
            archivedHistory.revisions,
            Order.mapInput(
              Order.Number,
              (revision: { readonly number: number }) => revision.number,
            ),
          ),
        )
        const opened =
          isArchived && Option.isSome(closing)
            ? yield* readLatestDraft(
                client,
                reportId,
                sectionIds,
                closing.value.draft,
              )
            : undefined
        if (!isArchived) {
          yield* client.StartWorkingCopy({ reportId })
        }
        const copy =
          opened ?? (yield* readWorkingCopy(client, reportId, sectionIds))
        const people =
          opened === undefined
            ? (yield* client.GetPeople({ reportId })).people
            : opened.people
        const drafting = yield* client
          .ListDrafting({ reportId })
          .pipe(Effect.catch(() => Effect.succeed([])))
        const history = yield* client
          .GetHistory({ reportId })
          .pipe(
            Effect.catch(() => Effect.succeed({ drafts: [], revisions: [] })),
          )
        const nowMs = yield* Clock.currentTimeMillis
        const units = yield* client.ListUnits()
        const unitMembers = yield* client
          .ListUnitMembers({ unit: detail.summary.caseFile.unit })
          .pipe(Effect.catch(() => Effect.succeed([])))
        // NOTE: Image space is a nicety; a report is opened without it if the
        // server cannot say (a member who may not read the working copy).
        const maybeImageUsage = yield* client.ListImages({ reportId }).pipe(
          Effect.map(list =>
            Option.some({
              usedBytes: list.referencedBytes,
              limitBytes: list.limitBytes,
            }),
          ),
          Effect.catch(() => Effect.succeed(Option.none())),
        )
        return {
          detail,
          template,
          maybeImageUsage,
          unitName:
            units.find(unit => unit.id === detail.summary.caseFile.unit)
              ?.name ?? '',
          contents: copy.contents,
          people,
          saveCounter: copy.saveCounter,
          savedAt: copy.savedAt,
          copy: copy.copy,
          myId: copy.ownerId,
          drafting,
          unitMembers,
          revisions: history.revisions,
          nowMs,
        }
      }),
    ).pipe(
      Effect.map(loaded => Message.SucceededLoadReport({ scope, loaded })),
      Effect.catch(error =>
        Effect.succeed(
          Message.FailedLoadReport({ scope, failure: failureOf(error) }),
        ),
      ),
    )
  },
})

export const SaveSection = Command.define('SaveSection', {
  args: {
    scope: Scope,
    sectionId: Schema.String,
    saveCounter: Schema.Int,
    content: SectionContent,
  },
  messages: [
    Message.SucceededSaveSection,
    Message.FailedSaveSection,
    Message.StaleSaveSection,
  ],
  execute: ({ scope, sectionId, saveCounter, content }) =>
    withQuoroom(client =>
      client.SaveSection({
        reportId: scope.reportId,
        sectionId,
        saveCounter,
        content,
      }),
    ).pipe(
      Effect.map(saved =>
        Message.SucceededSaveSection({
          scope,
          sectionId,
          saveCounter: saved.saveCounter,
          savedAt: saved.savedAt,
        }),
      ),
      Effect.catch(error =>
        Effect.succeed(
          isStaleSave(error)
            ? Message.StaleSaveSection({ scope, sectionId, sent: content })
            : Message.FailedSaveSection({
                scope,
                sectionId,
                failure: failureOf(error),
              }),
        ),
      ),
    ),
})

// NOTE: A save the server refused as stale may be one whose answer was lost:
// the server holds exactly what was sent and only the counter moved. The
// section is read again and the screen compares (`SucceededReadStaleSection`).
export const ReadStaleSection = Command.define('ReadStaleSection', {
  args: { scope: Scope, sectionId: Schema.String, sent: SectionContent },
  messages: [Message.SucceededReadStaleSection, Message.FailedReadStaleSection],
  execute: ({ scope, sectionId, sent }) =>
    withQuoroom(client =>
      Effect.gen(function* () {
        const outline = yield* client.GetWorkingCopy({
          reportId: scope.reportId,
        })
        const section = yield* client.GetWorkingCopySection({
          reportId: scope.reportId,
          sectionId,
        })
        return { outline, section }
      }),
    ).pipe(
      Effect.map(({ outline, section }) =>
        Message.SucceededReadStaleSection({
          scope,
          sectionId,
          sent,
          saved: section.content,
          saveCounter: outline.saveCounter,
          savedAt: outline.savedAt,
        }),
      ),
      Effect.catch(error =>
        Effect.succeed(
          Message.FailedReadStaleSection({
            scope,
            sectionId,
            failure: failureOf(error),
          }),
        ),
      ),
    ),
})

export const ReloadWorkingCopy = Command.define('ReloadWorkingCopy', {
  args: { scope: Scope, sectionIds: Schema.Array(Schema.String) },
  messages: [
    Message.SucceededReloadWorkingCopy,
    Message.FailedReloadWorkingCopy,
  ],
  execute: ({ scope, sectionIds }) =>
    withQuoroom(client =>
      readWorkingCopy(client, scope.reportId, sectionIds),
    ).pipe(
      Effect.map(copy =>
        Message.SucceededReloadWorkingCopy({ scope, ...copy }),
      ),
      Effect.catch(error =>
        Effect.succeed(
          Message.FailedReloadWorkingCopy({ scope, failure: failureOf(error) }),
        ),
      ),
    ),
})

// NOTE: Throws the author's working copy away and starts again from the
// latest shared draft (`replace`). The screen asks first.
export const ReplaceWorkingCopy = Command.define('ReplaceWorkingCopy', {
  args: { scope: Scope },
  messages: [Message.SucceededReplaceCopy, Message.FailedReplaceCopy],
  execute: ({ scope }) =>
    withQuoroom(client =>
      client.StartWorkingCopy({ reportId: scope.reportId, replace: true }),
    ).pipe(
      Effect.map(() => Message.SucceededReplaceCopy({ scope })),
      Effect.catch(error =>
        Effect.succeed(
          Message.FailedReplaceCopy({ scope, failure: failureOf(error) }),
        ),
      ),
    ),
})

// NOTE: An entry's ID is random and chosen here, so two authors who each add
// an entry to the same draft never choose the same one.
export const NewEntryId = Command.define('NewEntryId', {
  args: { scope: Scope, target: Target },
  messages: [Message.GeneratedEntryId],
  execute: ({ scope, target }) =>
    Effect.flatMap(Crypto.Crypto, crypto => crypto.randomUUIDv4).pipe(
      Effect.provide(BrowserCrypto.layer),
      Effect.map(uuid =>
        Message.GeneratedEntryId({
          scope,
          target,
          entryId: uuid.replaceAll('-', '').slice(0, 16),
        }),
      ),
      Effect.catch(() =>
        Effect.succeed(
          Message.GeneratedEntryId({ scope, target, entryId: '' }),
        ),
      ),
    ),
})

export const FocusConfirmation = Command.define('FocusConfirmation', {
  messages: [Message.CompletedFocusConfirmation],
  execute: Dom.focus(`#${CONFIRMATION_ID}`, { makeFocusable: true }).pipe(
    Effect.catch(() => Effect.void),
    Effect.as(Message.CompletedFocusConfirmation()),
  ),
})

export const LoadImageUsage = Command.define('LoadImageUsage', {
  args: { scope: Scope },
  messages: [Message.SucceededLoadImageUsage, Message.FailedLoadImageUsage],
  execute: ({ scope }) =>
    withQuoroom(client => client.ListImages({ reportId: scope.reportId })).pipe(
      Effect.map(list =>
        Message.SucceededLoadImageUsage({
          scope,
          usage: {
            usedBytes: list.referencedBytes,
            limitBytes: list.limitBytes,
          },
        }),
      ),
      Effect.catch(() =>
        Effect.succeed(Message.FailedLoadImageUsage({ scope })),
      ),
    ),
})

export const AddCoAuthor = Command.define('AddCoAuthor', {
  args: { scope: Scope, accountId: Schema.String },
  messages: [Message.SucceededAddCoAuthor, Message.FailedAddCoAuthor],
  execute: ({ scope, accountId }) =>
    withQuoroom(client =>
      client.AddCoAuthor({ reportId: scope.reportId, accountId }),
    ).pipe(
      Effect.map(added =>
        Message.SucceededAddCoAuthor({ scope, account: added.account }),
      ),
      Effect.catch(error =>
        Effect.succeed(
          Message.FailedAddCoAuthor({ scope, failure: failureOf(error) }),
        ),
      ),
    ),
})

export const FocusSectionHeading = Command.define('FocusSectionHeading', {
  messages: [Message.CompletedFocusSectionHeading],
  execute: Dom.focus(`#${SECTION_HEADING_ID}`, { makeFocusable: true }).pipe(
    Effect.catch(() => Effect.void),
    Effect.as(Message.CompletedFocusSectionHeading()),
  ),
})

// NOTE: "Who is drafting": the working copies of the report's authors, read
// when the page loads and again every 30 seconds while it is open. A failed
// refresh keeps what is shown.
export const RefreshDrafting = Command.define('RefreshDrafting', {
  args: { scope: Scope },
  messages: [Message.SucceededRefreshDrafting],
  execute: ({ scope }) =>
    withQuoroom(client =>
      client.ListDrafting({ reportId: scope.reportId }),
    ).pipe(
      Effect.map(drafting =>
        Message.SucceededRefreshDrafting({ scope, drafting }),
      ),
      Effect.catch(() =>
        Effect.succeed(
          Message.SucceededRefreshDrafting({ scope, drafting: [] }),
        ),
      ),
    ),
})

// NOTE: The report and its rounds read again: a deadline passed while the
// screen was open, or the conclusion was just started. The server settles
// overdue rounds on every read.
export const RefreshRounds = Command.define('RefreshRounds', {
  args: { scope: Scope },
  messages: [Message.SucceededRefreshRounds, Message.FailedRefreshRounds],
  execute: ({ scope }) =>
    withQuoroom(client =>
      Effect.all({
        detail: client.GetReport({ reportId: scope.reportId }),
        history: client.GetHistory({ reportId: scope.reportId }),
      }),
    ).pipe(
      Effect.map(({ detail, history }) =>
        Message.SucceededRefreshRounds({
          scope,
          detail,
          revisions: history.revisions,
        }),
      ),
      Effect.catch(() =>
        Effect.succeed(Message.FailedRefreshRounds({ scope })),
      ),
    ),
})

export const StartReportConclusion = Command.define('StartReportConclusion', {
  args: { scope: Scope },
  messages: [Message.SucceededStartConclusion, Message.FailedStartConclusion],
  execute: ({ scope }) =>
    withQuoroom(client =>
      client.StartConclusion({ reportId: scope.reportId }),
    ).pipe(
      Effect.map(() => Message.SucceededStartConclusion({ scope })),
      Effect.catch(error =>
        Effect.succeed(
          Message.FailedStartConclusion({ scope, failure: failureOf(error) }),
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

export type Editability =
  | Readonly<{ kind: 'editable' }>
  | Readonly<{ kind: 'read_only'; reason: string }>

const READ_ONLY_ARCHIVED =
  'This report is archived. It can be read, not changed.'
const READ_ONLY_PERMISSION = 'Your role in this report does not allow editing.'
const READ_ONLY_CONCLUDING =
  'The report is concluding. Only the conclusion can be edited now.'
const READ_ONLY_NOT_CONCLUDING =
  'The conclusion can be written once the report is concluding.'

// NOTE: What the server will accept (`checkSave`): nothing in an archived
// report, only the conclusion while concluding, and never the conclusion
// before that. The screen shows it up front so no one types into a field that
// would be refused.
export const editability = (
  template: Template,
  state: ReportState,
  permissions: ReadonlyArray<Permission>,
  topSectionId: string,
): Editability => {
  const isConclusion = template.conclusion?.id === topSectionId
  if (state === 'archived') {
    return { kind: 'read_only', reason: READ_ONLY_ARCHIVED }
  }
  if (!Array.contains(permissions, 'edit')) {
    return { kind: 'read_only', reason: READ_ONLY_PERMISSION }
  }
  if (state === 'concluding' && !isConclusion) {
    return { kind: 'read_only', reason: READ_ONLY_CONCLUDING }
  }
  if (state !== 'concluding' && isConclusion) {
    return { kind: 'read_only', reason: READ_ONLY_NOT_CONCLUDING }
  }
  return { kind: 'editable' }
}

export type Outline = Readonly<{
  rows: ReadonlyArray<NumberedSection>
  states: ReadonlyMap<string, SectionState>
  end: EndState
}>

// NOTE: An entry without a title of its own is called by its section's title
// and its place in the list ("Allegation 2").
const withDisplayTitles = (
  template: Template,
  contents: SectionContents,
  rows: ReadonlyArray<NumberedSection>,
): ReadonlyArray<NumberedSection> =>
  Array.map(rows, row => {
    if (row.entryId === undefined) {
      return row
    }
    const entries = entriesOfKey(contents, groupKeyOf(row.key))
    const index = entries.findIndex(entry => entry.id === row.entryId)
    const entry = entries[index]
    const section = sectionOfKey(template, groupKeyOf(row.key))
    return entry === undefined || section === undefined
      ? row
      : { ...row, title: entryDisplayTitle(entry, section.title, index) }
  })

export const outlineOf = (template: Template, model: Model): Outline => ({
  rows: withDisplayTitles(
    template,
    model.contents,
    numberSections(template, { sections: model.contents }),
  ),
  states: sectionStates(template, { sections: model.contents }),
  end: endState(template, { sections: model.contents }),
})

export const selectedKeyOf = (
  model: Model,
  rows: ReadonlyArray<NumberedSection>,
): string =>
  Option.match(
    Option.filter(model.maybeSelectedKey, key =>
      Array.some(rows, row => row.key === key),
    ),
    {
      onNone: () => rows[0]?.key ?? '',
      onSome: key => key,
    },
  )

export const authorCandidates = (
  model: Model,
): ReadonlyArray<typeof UnitMember.Type> =>
  Option.match(model.maybeDetail, {
    onNone: () => [],
    onSome: detail =>
      Array.filter(
        model.unitMembers,
        member =>
          member.isAuthor &&
          member.active &&
          !Array.some(detail.authors, author => author.id === member.accountId),
      ),
  })

export const stateText = (state: SectionState): string =>
  state === 'empty'
    ? 'Not started'
    : state === 'in_progress'
      ? 'In progress'
      : state === 'complete'
        ? 'Complete'
        : state === 'not_applicable'
          ? 'Not applicable'
          : 'Ended'

export const reportStateText = (state: ReportState): string =>
  state === 'drafting'
    ? 'Drafting'
    : state === 'in_review'
      ? 'In review'
      : state === 'decided'
        ? 'Decided'
        : state === 'concluding'
          ? 'Concluding'
          : 'Archived'

// INIT

export const scopeOf = (model: Model): Scope => ({
  reportId: model.reportId,
  generation: model.generation,
  epoch: model.epoch,
})

const isCurrent = (model: Model, scope: Scope): boolean =>
  isCurrentPage(model, scope) && model.epoch === scope.epoch

// NOTE: `generation` is the entry of the screen: the parent passes one higher
// than the screen had, so an answer to a Command of an earlier entry (even of
// the same report) is never taken for one of this entry.
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
  return { model: fresh, commands: [LoadReport({ scope: scopeOf(fresh) })] }
}

// NOTE: What the screen does when it is asked to try saving again, for the
// parent that waits for a save before the report is left.
export const retrySave = (model: Model): Update.Return<Model, Message> =>
  SaveStatus.guards.Saving(model.save)
    ? { model }
    : update(model, Message.ClickedRetrySave())

// NOTE: The screen emptied (signed out, or left with edits given up): nothing
// that is still on its way reaches the new Model.
export const cleared = (model: Model): Model =>
  modifyFields(initialModel, { generation: () => model.generation + 1 })

// UPDATE

export const hasUnsavedEdits = (model: Model): boolean =>
  !Array.isReadonlyArrayEmpty(model.dirtySectionIds) ||
  !SaveStatus.guards.Saved(model.save)

// NOTE: Why the edits are not saved yet, for the question asked before the
// report is left.
export const unsavedReason = (
  model: Model,
): 'offline' | 'failed' | 'stale' | 'saving' =>
  SaveStatus.guards.Stale(model.save)
    ? 'stale'
    : SaveStatus.guards.Failed(model.save)
      ? 'failed'
      : model.isOnline
        ? 'saving'
        : 'offline'

const EMPTY_SECTION: SectionContent = { values: {}, sections: {} }

// NOTE: One save at a time, in the order the sections were edited. Nothing is
// sent while a save is in flight, while the working copy is known to be stale
// (the edit is kept and the author is asked to reload), or while the browser
// is offline.
const startSave = (model: Model): Update.Return<Model, Message> => {
  if (
    SaveStatus.guards.Saving(model.save) ||
    SaveStatus.guards.Stale(model.save) ||
    model.isReloading ||
    !model.isOnline
  ) {
    return { model }
  }
  const [next, ...rest] = model.dirtySectionIds
  if (next === undefined) {
    return { model: modifyFields(model, { save: () => SaveStatus.Saved() }) }
  }
  return {
    model: modifyFields(model, {
      dirtySectionIds: () => rest,
      save: () => SaveStatus.Saving({ sectionId: next }),
    }),
    commands: [
      SaveSection({
        scope: scopeOf(model),
        sectionId: next,
        saveCounter: model.saveCounter,
        content: model.contents[next] ?? EMPTY_SECTION,
      }),
    ],
  }
}

const withDirty = (model: Model, sectionId: string): Model =>
  modifyFields(model, {
    dirtySectionIds: ids =>
      Array.contains(ids, sectionId) ? ids : Array.append(ids, sectionId),
  })

const withAuthor = (
  detail: typeof ReportDetail.Type,
  account: AccountRef,
): typeof ReportDetail.Type => ({
  ...detail,
  authors: Array.some(detail.authors, author => author.id === account.id)
    ? detail.authors
    : Array.append(detail.authors, account),
})

const REFUSED_RICH_TEXT =
  'That change to the text uses something Quoroom cannot store, so it was not saved.'

const stepKey = (step: ItemStep): string => `${step.itemId}#${step.entryId}`

// NOTE: The editor of an item inside an entry is told apart from the same item
// in another entry by the entries above it.
export const richKey = (
  sectionKey: string,
  steps: ReadonlyArray<ItemStep>,
  itemId: string,
): string =>
  editorKey(sectionKey, [...Array.map(steps, stepKey), itemId].join('/'))

const hasRichText = (items: Section['items']): boolean =>
  Array.some(
    items,
    item =>
      item.type === 'rich_text' ||
      (item.type === 'repeated' && hasRichText(item.items)),
  )

const setNote = (model: Model, note: string): Model =>
  modifyFields(model, { maybeEditNote: () => Option.some(note) })

export const showsEditableRichText = (model: Model): boolean =>
  Option.match(
    Option.all({ detail: model.maybeDetail, template: model.maybeTemplate }),
    {
      onNone: () => false,
      onSome: ({ detail, template }) => {
        const outline = outlineOf(template, model)
        const key = selectedKeyOf(model, outline.rows)
        const section = sectionOfKey(template, key)
        return (
          section !== undefined &&
          outline.states.get(key) !== 'ended' &&
          editability(
            template,
            detail.summary.state,
            detail.permissions,
            topSectionIdOfKey(key),
          ).kind === 'editable' &&
          hasRichText(section.items)
        )
      },
    },
  )

const requestEditor = (model: Model): Update.Return<Model, Message> =>
  EditorState.guards.NotLoaded(model.editor) && showsEditableRichText(model)
    ? {
        model: modifyFields(model, { editor: () => EditorState.Loading() }),
        commands: [LoadEditor()],
      }
    : { model }

const selectSection =
  (key: string): Update.Step<Model, Message> =>
  stepModel => ({
    model: modifyFields(stepModel, {
      maybeSelectedKey: () => Option.some(key),
      isNavigatorOpen: () => false,
      maybeSelection: () => Option.none(),
      titleDrafts: () => ({}),
    }),
    commands: [FocusSectionHeading()],
  })

// NOTE: Every change to the content goes through here: it is stored, its
// top-level section is queued for saving, and the editor is loaded if the
// change brought a rich-text item into view.
const edited = (
  model: Model,
  contents: SectionContents,
  sectionKey: string,
): Update.Return<Model, Message> =>
  Update.combine(model, [
    stepModel =>
      startSave(
        withDirty(
          modifyFields(stepModel, {
            contents: () => contents,
            maybeEditNote: () => Option.none(),
          }),
          topSectionIdOfKey(sectionKey),
        ),
      ),
    requestEditor,
  ])

const applyItemChange = (
  model: Model,
  sectionKey: string,
  steps: ReadonlyArray<ItemStep>,
  itemId: string,
  maybeValue: Option.Option<ItemValue>,
): Update.Return<Model, Message> =>
  edited(
    model,
    withItemValueAt(
      model.contents,
      sectionKey,
      steps,
      itemId,
      Option.getOrUndefined(maybeValue),
    ),
    sectionKey,
  )

// NOTE: After a reload, or an edit put back, the editors must take the content
// from the Model. A version is not enough: an element may have taken keystrokes
// it has not reported yet, so its version is higher than any the Model has
// seen. A new generation makes every element replace its text, whatever its
// version, and report what it had not sent as `DiscardedRichText`.
const resetEditors = (model: Model): Model =>
  modifyFields(model, { editorGeneration: generation => generation + 1 })

const withNewEpoch = (model: Model): Model =>
  modifyFields(model, { epoch: epoch => epoch + 1 })

const withTemplate = (
  model: Model,
  use: (template: Template) => Update.Return<Model, Message>,
): Update.Return<Model, Message> =>
  Option.match(model.maybeTemplate, {
    onNone: () => ({ model }),
    onSome: use,
  })

const isSectionTarget = (target: Target): boolean =>
  Option.isNone(target.maybeItemId)

const afterRemoval = (
  model: Model,
  target: Target,
  entryId: string,
): Update.Step<Model, Message> => {
  const removedKey = entryKeyOf(target.sectionKey, entryId)
  return stepModel =>
    isSectionTarget(target) &&
    Option.exists(
      stepModel.maybeSelectedKey,
      key => key === removedKey || key.startsWith(`${removedKey}/`),
    )
      ? selectSection(parentKeyOf(removedKey))(stepModel)
      : { model: stepModel }
}

const setSectionContent = (
  contents: SectionContents,
  sectionId: string,
  content: SectionContent,
): SectionContents => {
  const { [sectionId]: _old, ...rest } = contents
  return hasContent(content) ? { ...rest, [sectionId]: content } : rest
}

const sectionIdsOf = (template: Template): ReadonlyArray<string> =>
  Array.map(topLevelSections(template), section => section.id)

const WAIT_FOR_SAVE =
  'A save is still in progress. Wait for it to finish, then try again.'

const CANCELLED_UPLOAD =
  'The picture was not added, because you left the text while it was being sent. Add it again.'

const sectionTitleOf = (template: Template, sectionId: string): string =>
  Array.findFirst(
    topLevelSections(template),
    section => section.id === sectionId,
  ).pipe(
    Option.map(section => section.title),
    Option.getOrElse(() => sectionId),
  )

// NOTE: A rich-text change from an editor, or the last one an editor sent as
// it went away (`FlushedRichText`).
const richTextChanged = (
  model: Model,
  sectionKey: string,
  steps: ReadonlyArray<ItemStep>,
  itemId: string,
  content: string,
  version: number,
): Update.Return<Model, Message> =>
  Option.match(parseRichTextJson(content), {
    onNone: () => ({
      model: modifyFields(model, {
        maybeRefusal: () => Option.some(REFUSED_RICH_TEXT),
      }),
    }),
    onSome: doc =>
      applyItemChange(
        modifyFields(model, {
          editorVersions: versions =>
            Record.set(versions, richKey(sectionKey, steps, itemId), version),
          maybeRefusal: () => Option.none(),
        }),
        sectionKey,
        steps,
        itemId,
        serializeRichText(doc) === EMPTY_RICH_TEXT_JSON
          ? Option.none()
          : Option.some({ type: 'rich_text', doc }),
      ),
  })

// NOTE: Text an editor had taken but not reported when its text was replaced
// (a reload): it is kept beside the saved version, never saved over it. The
// kept version is what the page held (the kept edit of the section, or else
// the saved section) with that text in it.
const keepDiscardedRichText = (
  model: Model,
  sectionKey: string,
  steps: ReadonlyArray<ItemStep>,
  itemId: string,
  content: string,
): Update.Return<Model, Message> =>
  Option.match(parseRichTextJson(content), {
    onNone: () => ({ model }),
    onSome: doc => {
      const sectionId = topSectionIdOfKey(sectionKey)
      const base = Array.findFirst(
        model.keptEdits,
        edit => edit.sectionId === sectionId,
      ).pipe(
        Option.map(edit => edit.content),
        Option.getOrElse(() => model.contents[sectionId] ?? EMPTY_SECTION),
      )
      const withText = withItemValueAt(
        { [sectionId]: base },
        sectionKey,
        steps,
        itemId,
        serializeRichText(doc) === EMPTY_RICH_TEXT_JSON
          ? undefined
          : { type: 'rich_text', doc },
      )[sectionId]
      const keptContent = withText ?? EMPTY_SECTION
      return sameContent(
        keptContent,
        model.contents[sectionId] ?? EMPTY_SECTION,
      )
        ? { model }
        : {
            model: modifyFields(model, {
              keptEdits: edits => [
                ...Array.filter(edits, edit => edit.sectionId !== sectionId),
                { sectionId, content: keptContent },
              ],
            }),
          }
    },
  })

const updateCurrent = (model: Model, message: Message) =>
  Message.match<Update.Return<Model, Message>>(message, {
    SucceededLoadReport: ({ loaded }) =>
      Update.combine(model, [
        stepModel => ({
          model: modifyFields(stepModel, {
            load: () => LoadState.Loaded(),
            maybeDetail: () => Option.some(loaded.detail),
            maybeTemplate: () => Option.some(loaded.template),
            unitName: () => loaded.unitName,
            contents: () => loaded.contents,
            people: () => loaded.people,
            saveCounter: () => loaded.saveCounter,
            unitMembers: () => loaded.unitMembers,
            maybeImageUsage: () => loaded.maybeImageUsage,
            maybeSavedAt: () => Option.some(loaded.savedAt),
            maybeCopy: () => Option.some(loaded.copy),
            myId: () => loaded.myId,
            drafting: () => loaded.drafting,
            revisions: () => loaded.revisions,
            nowMs: () => loaded.nowMs,
          }),
        }),
        requestEditor,
      ]),
    FailedLoadReport: ({ failure }) => ({
      model: modifyFields(model, { load: () => LoadState.Failed({ failure }) }),
    }),
    ClickedRetryLoad: () => ({
      model: modifyFields(model, { load: () => LoadState.Loading() }),
      commands: [LoadReport({ scope: scopeOf(model) })],
    }),
    SelectedSection: ({ key }) =>
      Update.combine(model, [selectSection(key), requestEditor]),
    ChoseView: ({ view }) => ({
      model: modifyFields(model, { view: () => view }),
    }),
    ToggledNavigator: () => ({
      model: modifyFields(model, { isNavigatorOpen: open => !open }),
    }),
    ChangedItem: ({ sectionKey, steps, itemId, maybeValue }) =>
      applyItemChange(model, sectionKey, steps, itemId, maybeValue),
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
    ChangedRichText: ({ sectionKey, steps, itemId, content, version }) =>
      richTextChanged(model, sectionKey, steps, itemId, content, version),
    FlushedRichText: ({ sectionKey, steps, itemId, content, version }) =>
      richTextChanged(model, sectionKey, steps, itemId, content, version),
    DiscardedRichText: ({ sectionKey, steps, itemId, content }) =>
      keepDiscardedRichText(model, sectionKey, steps, itemId, content),
    CancelledImageUpload: () => ({
      model: setNote(model, CANCELLED_UPLOAD),
    }),
    AddedImage: () => ({
      model,
      commands: [LoadImageUsage({ scope: scopeOf(model) })],
    }),
    SucceededLoadImageUsage: ({ usage }) => ({
      model: modifyFields(model, { maybeImageUsage: () => Option.some(usage) }),
    }),
    FailedLoadImageUsage: () => ({ model }),
    SelectedRichTextRange: ({ sectionKey, itemId, from, to, text }) => ({
      model: modifyFields(model, {
        maybeSelection: () =>
          from === to || text === ''
            ? Option.none()
            : Option.some({ sectionKey, itemId, from, to, text }),
      }),
    }),

    // -- Saving (stage 4f)
    SucceededSaveSection: ({ saveCounter, savedAt }) =>
      startSave(
        modifyFields(model, {
          saveCounter: () => saveCounter,
          maybeSavedAt: () => Option.some(savedAt),
          save: () => SaveStatus.Saved(),
        }),
      ),
    FailedSaveSection: ({ sectionId, failure }) => ({
      model: modifyFields(withDirty(model, sectionId), {
        save: () => SaveStatus.Failed({ failure }),
      }),
    }),
    StaleSaveSection: ({ sectionId, sent }) => ({
      model,
      commands: [ReadStaleSection({ scope: scopeOf(model), sectionId, sent })],
    }),
    SucceededReadStaleSection: ({
      sectionId,
      sent,
      saved,
      saveCounter,
      savedAt,
    }) =>
      sameContent(sent, saved)
        ? startSave(
            modifyFields(model, {
              saveCounter: () => saveCounter,
              maybeSavedAt: () => Option.some(savedAt),
              save: () => SaveStatus.Saved(),
            }),
          )
        : {
            model: modifyFields(withDirty(model, sectionId), {
              save: () => SaveStatus.Stale({ sectionId }),
            }),
          },
    FailedReadStaleSection: ({ sectionId, failure }) => ({
      model: modifyFields(withDirty(model, sectionId), {
        save: () => SaveStatus.Failed({ failure }),
      }),
    }),
    ClickedRetrySave: () =>
      startSave(
        modifyFields(model, {
          save: () =>
            SaveStatus.guards.Stale(model.save)
              ? model.save
              : SaveStatus.Saved(),
        }),
      ),
    TickedSaveRetry: () =>
      SaveStatus.guards.Failed(model.save)
        ? startSave(modifyFields(model, { save: () => SaveStatus.Saved() }))
        : { model },
    ChangedConnection: ({ isOnline }) => {
      const next = modifyFields(model, { isOnline: () => isOnline })
      return isOnline
        ? startSave(
            SaveStatus.guards.Failed(next.save)
              ? modifyFields(next, { save: () => SaveStatus.Saved() })
              : next,
          )
        : { model: next }
    },
    WarnedBeforeLeaving: () => ({ model }),
    ClickedReloadWorkingCopy: () =>
      model.isReloading
        ? { model }
        : SaveStatus.guards.Saving(model.save)
          ? { model: setNote(model, WAIT_FOR_SAVE) }
          : withTemplate(model, template => ({
              model: modifyFields(model, {
                isReloading: () => true,
                maybeEditNote: () => Option.none(),
              }),
              commands: [
                ReloadWorkingCopy({
                  scope: scopeOf(model),
                  sectionIds: sectionIdsOf(template),
                }),
              ],
            })),
    SucceededReloadWorkingCopy: ({ contents, saveCounter, savedAt, copy }) => {
      // NOTE: What this page held and the server does not is not thrown away:
      // it is kept beside the saved version, to be copied or put back.
      const unsaved = Array.dedupe([
        ...model.dirtySectionIds,
        ...(SaveStatus.guards.Stale(model.save) ? [model.save.sectionId] : []),
        ...(SaveStatus.guards.Saving(model.save) ? [model.save.sectionId] : []),
      ])
      const kept = Array.flatMap(unsaved, sectionId => {
        const local = model.contents[sectionId] ?? EMPTY_SECTION
        return sameContent(local, contents[sectionId] ?? EMPTY_SECTION)
          ? []
          : [{ sectionId, content: local }]
      })
      return {
        model: resetEditors(
          withNewEpoch(
            modifyFields(model, {
              contents: () => contents,
              saveCounter: () => saveCounter,
              maybeSavedAt: () => Option.some(savedAt),
              maybeCopy: () => Option.some(copy),
              dirtySectionIds: () => [],
              save: () => SaveStatus.Saved(),
              isReloading: () => false,
              keptEdits: existing => [
                ...Array.filter(
                  existing,
                  edit =>
                    !Array.some(
                      kept,
                      other => other.sectionId === edit.sectionId,
                    ),
                ),
                ...kept,
              ],
            }),
          ),
        ),
      }
    },
    FailedReloadWorkingCopy: ({ failure }) => ({
      model: modifyFields(setNote(model, failureText(failure)), {
        isReloading: () => false,
      }),
    }),
    ClickedReapplyEdit: ({ sectionId }) =>
      withTemplate(model, template =>
        Option.match(
          Array.findFirst(
            model.keptEdits,
            edit => edit.sectionId === sectionId,
          ),
          {
            onNone: () => ({ model }),
            onSome: () => ({
              model: modifyFields(model, {
                maybeConfirmation: () =>
                  Option.some(
                    Confirmation.ReapplyEdit({
                      sectionId,
                      title: sectionTitleOf(template, sectionId),
                    }),
                  ),
              }),
              commands: [FocusConfirmation()],
            }),
          },
        ),
      ),
    ConfirmedReapplyEdit: () =>
      Option.match(
        Option.filter(model.maybeConfirmation, Confirmation.guards.ReapplyEdit),
        {
          onNone: () => ({ model }),
          onSome: ({ sectionId }) =>
            Option.match(
              Array.findFirst(
                model.keptEdits,
                edit => edit.sectionId === sectionId,
              ),
              {
                onNone: () => ({
                  model: modifyFields(model, {
                    maybeConfirmation: () => Option.none(),
                  }),
                }),
                onSome: edit =>
                  Update.combine(
                    modifyFields(model, {
                      maybeConfirmation: () => Option.none(),
                    }),
                    [
                      stepModel =>
                        startSave(
                          withDirty(
                            resetEditors(
                              modifyFields(stepModel, {
                                contents: contents =>
                                  setSectionContent(
                                    contents,
                                    sectionId,
                                    edit.content,
                                  ),
                                keptEdits: edits =>
                                  Array.filter(
                                    edits,
                                    other => other.sectionId !== sectionId,
                                  ),
                              }),
                            ),
                            sectionId,
                          ),
                        ),
                      requestEditor,
                    ],
                  ),
              },
            ),
        },
      ),
    ClickedDiscardEdit: ({ sectionId }) => ({
      model: modifyFields(model, {
        keptEdits: edits =>
          Array.filter(edits, edit => edit.sectionId !== sectionId),
      }),
    }),
    ClickedReplaceCopy: () => ({
      model: modifyFields(model, {
        maybeConfirmation: () => Option.some(Confirmation.ReplaceCopy()),
      }),
      commands: [FocusConfirmation()],
    }),
    ConfirmedReplaceCopy: () =>
      !Option.exists(model.maybeConfirmation, Confirmation.guards.ReplaceCopy)
        ? { model }
        : SaveStatus.guards.Saving(model.save)
          ? {
              model: modifyFields(setNote(model, WAIT_FOR_SAVE), {
                maybeConfirmation: () => Option.none(),
              }),
            }
          : {
              model: modifyFields(model, {
                maybeConfirmation: () => Option.none(),
                isReloading: () => true,
              }),
              commands: [ReplaceWorkingCopy({ scope: scopeOf(model) })],
            },
    SucceededReplaceCopy: () => {
      const restarted = resetEditors(
        withNewEpoch(
          modifyFields(model, {
            load: () => LoadState.Loading(),
            contents: () => ({}),
            dirtySectionIds: () => [],
            keptEdits: () => [],
            save: () => SaveStatus.Saved(),
            isReloading: () => false,
            naDrafts: () => ({}),
            naStash: () => ({}),
            titleDrafts: () => ({}),
            editorVersions: () => ({}),
            maybeSelectedKey: () => Option.none(),
            maybeEditNote: () => Option.none(),
          }),
        ),
      )
      return {
        model: restarted,
        commands: [LoadReport({ scope: scopeOf(restarted) })],
      }
    },
    FailedReplaceCopy: ({ failure }) => ({
      model: modifyFields(setNote(model, failureText(failure)), {
        isReloading: () => false,
      }),
    }),
    CancelledConfirmation: () => ({
      model: modifyFields(model, { maybeConfirmation: () => Option.none() }),
    }),
    CompletedFocusConfirmation: () => ({ model }),

    // -- Entries (stage 4e)
    ClickedAddEntry: ({ target }) =>
      withTemplate(model, template =>
        Option.match(addRefusal(template, model.contents, target), {
          onSome: note => ({ model: setNote(model, note) }),
          onNone: () => ({
            model: modifyFields(model, { maybeEditNote: () => Option.none() }),
            commands: [NewEntryId({ scope: scopeOf(model), target })],
          }),
        }),
      ),
    GeneratedEntryId: ({ target, entryId }) =>
      withTemplate(model, template =>
        entryId === ''
          ? { model: setNote(model, 'Nothing was added. Try again.') }
          : Result.match(
              addEntryTo(template, model.contents, target, entryId),
              {
                onFailure: note => ({ model: setNote(model, note) }),
                onSuccess: contents =>
                  Update.combine(model, [
                    stepModel => edited(stepModel, contents, target.sectionKey),
                    ...(isSectionTarget(target)
                      ? [
                          selectSection(entryKeyOf(target.sectionKey, entryId)),
                          requestEditor,
                        ]
                      : []),
                  ]),
              },
            ),
      ),
    ClickedMoveEntry: ({ target, entryId, step }) =>
      edited(
        model,
        moveEntryIn(model.contents, target, entryId, step < 0 ? -1 : 1),
        target.sectionKey,
      ),
    ClickedRemoveEntry: ({ target, entryId, label }) =>
      withTemplate(model, template =>
        Result.match(
          removeEntryFrom(template, model.contents, target, entryId),
          {
            onFailure: note => ({ model: setNote(model, note) }),
            onSuccess: () => ({
              model: modifyFields(model, {
                maybeEditNote: () => Option.none(),
                maybeConfirmation: () =>
                  Option.some(
                    Confirmation.RemoveEntry({ target, entryId, label }),
                  ),
              }),
              commands: [FocusConfirmation()],
            }),
          },
        ),
      ),
    ConfirmedRemoveEntry: () =>
      withTemplate(model, template =>
        Option.match(
          Option.filter(
            model.maybeConfirmation,
            Confirmation.guards.RemoveEntry,
          ),
          {
            onNone: () => ({ model }),
            onSome: confirmation =>
              Result.match(
                removeEntryFrom(
                  template,
                  model.contents,
                  confirmation.target,
                  confirmation.entryId,
                ),
                {
                  onFailure: note => ({
                    model: modifyFields(setNote(model, note), {
                      maybeConfirmation: () => Option.none(),
                    }),
                  }),
                  onSuccess: contents =>
                    Update.combine(
                      modifyFields(model, {
                        maybeConfirmation: () => Option.none(),
                      }),
                      [
                        stepModel =>
                          edited(
                            stepModel,
                            contents,
                            confirmation.target.sectionKey,
                          ),
                        afterRemoval(
                          model,
                          confirmation.target,
                          confirmation.entryId,
                        ),
                      ],
                    ),
                },
              ),
          },
        ),
      ),
    ChangedEntryTitle: ({ target, entryId, text }) =>
      edited(
        modifyFields(model, {
          titleDrafts: drafts =>
            Record.set(drafts, entryKeyOf(target.sectionKey, entryId), text),
        }),
        retitleEntryIn(model.contents, target, entryId, text),
        target.sectionKey,
      ),
    OpenedNotApplicable: ({ target, reason }) => ({
      model: modifyFields(model, {
        naDrafts: drafts =>
          Record.set(drafts, targetId(target), { reason, isMissing: false }),
      }),
    }),
    TypedNotApplicableReason: ({ target, text }) => ({
      model: modifyFields(model, {
        naDrafts: drafts =>
          Record.set(drafts, targetId(target), {
            reason: text,
            isMissing: false,
          }),
      }),
    }),
    CancelledNotApplicable: ({ target }) => ({
      model: modifyFields(model, {
        naDrafts: drafts => Record.remove(drafts, targetId(target)),
      }),
    }),
    SubmittedNotApplicable: ({ target }) => {
      const id = targetId(target)
      const reason = model.naDrafts[id]?.reason ?? ''
      if (reason.trim() === '') {
        return {
          model: modifyFields(model, {
            naDrafts: drafts =>
              Record.set(drafts, id, { reason, isMissing: true }),
          }),
        }
      }
      const current = valueOf(model.contents, target)
      const stashed = Option.filter(
        current,
        value => value.type !== 'not_applicable',
      )
      return edited(
        modifyFields(model, {
          naDrafts: drafts => Record.remove(drafts, id),
          naStash: stash =>
            Option.match(stashed, {
              onNone: () => stash,
              onSome: value => Record.set(stash, id, value),
            }),
        }),
        markNotApplicable(model.contents, target, reason),
        target.sectionKey,
      )
    },
    RestoredApplicable: ({ target }) => {
      const id = targetId(target)
      return edited(
        modifyFields(model, {
          naStash: stash => Record.remove(stash, id),
          naDrafts: drafts => Record.remove(drafts, id),
        }),
        clearNotApplicable(
          model.contents,
          target,
          Option.fromNullishOr(model.naStash[id]),
        ),
        target.sectionKey,
      )
    },

    SelectedCoAuthor: ({ value }) => ({
      model: modifyFields(model, {
        coAuthorChoice: () => value,
        coAuthorForm: () => FormState.Editing(),
        maybeNotice: () => Option.none(),
      }),
    }),
    SubmittedCoAuthor: () => {
      if (isSubmitting(model.coAuthorForm)) {
        return { model }
      }
      if (model.coAuthorChoice === '') {
        return {
          model: modifyFields(model, {
            coAuthorForm: () =>
              FormState.Invalid({ message: 'Choose an author from the list.' }),
          }),
        }
      }
      return {
        model: modifyFields(model, {
          coAuthorForm: () => FormState.Submitting(),
        }),
        commands: [
          AddCoAuthor({
            scope: scopeOf(model),
            accountId: model.coAuthorChoice,
          }),
        ],
      }
    },
    SucceededAddCoAuthor: ({ account }) => ({
      model: modifyFields(model, {
        maybeDetail: maybeDetail =>
          Option.map(maybeDetail, detail => withAuthor(detail, account)),
        coAuthorChoice: () => '',
        coAuthorForm: () => FormState.Editing(),
        maybeNotice: () =>
          Option.some(`${account.name} is now an author of this report.`),
      }),
    }),
    FailedAddCoAuthor: ({ failure }) => ({
      model: modifyFields(model, {
        coAuthorForm: () => FormState.Failed({ failure }),
      }),
    }),
    CompletedFocusSectionHeading: () => ({ model }),
    TickedRoundClock: ({ nowMs }) => ({
      model: modifyFields(model, { nowMs: () => nowMs }),
      commands: Option.match(currentRoundOf(model.revisions), {
        onNone: () => [],
        onSome: round =>
          nowMs >= round.deadline.at && model.nowMs < round.deadline.at
            ? [RefreshRounds({ scope: scopeOf(model) })]
            : [],
      }),
    }),
    ClickedStartConclusion: () => ({
      model: modifyFields(model, {
        maybeConfirmation: () => Option.some(Confirmation.StartConclusion()),
      }),
      commands: [FocusConfirmation()],
    }),
    ConfirmedStartConclusion: () =>
      !Option.exists(
        model.maybeConfirmation,
        Confirmation.guards.StartConclusion,
      )
        ? { model }
        : {
            model: modifyFields(model, {
              maybeConfirmation: () => Option.none(),
            }),
            commands: [StartReportConclusion({ scope: scopeOf(model) })],
          },
    SucceededStartConclusion: () => ({
      model: setNote(model, 'The conclusion was started.'),
      commands: [RefreshRounds({ scope: scopeOf(model) })],
    }),
    FailedStartConclusion: ({ failure }) => ({
      model: setNote(model, failureText(failure)),
      commands: [RefreshRounds({ scope: scopeOf(model) })],
    }),
    FailedRefreshRounds: () => ({ model }),
    SucceededRefreshRounds: ({ detail, revisions }) => ({
      model: modifyFields(model, {
        maybeDetail: () => Option.some(detail),
        revisions: () => revisions,
      }),
    }),
    TickedDraftingRefresh: () => ({
      model,
      commands: [RefreshDrafting({ scope: scopeOf(model) })],
    }),
    SucceededRefreshDrafting: ({ drafting }) => ({
      model: modifyFields(model, { drafting: () => drafting }),
    }),
  })

export const update = (
  model: Model,
  message: Message,
): Update.Return<Model, Message> =>
  'scope' in message && !isCurrent(model, message.scope)
    ? { model }
    : updateCurrent(model, message)

// NOTE: Escape answers the open question with "no".
export const dismissDialog = (model: Model): Update.Return<Model, Message> =>
  update(model, Message.CancelledConfirmation())

// SUBSCRIPTION

export const SAVE_RETRY_SECONDS = 5
const ROUND_CLOCK_SECONDS = 30
export const DRAFTING_REFRESH_SECONDS = 30

// NOTE: What an editor element puts in its `owner` property: who the text
// belongs to, so a message it sends as it goes away (after Foldkit has taken
// its listeners off) can still be told to the Model.
export const EditorOwner = Schema.Struct({
  scope: Scope,
  sectionKey: Schema.String,
  steps: Schema.Array(StepSchema),
  itemId: Schema.String,
})
export type EditorOwner = typeof EditorOwner.Type

export const ownerText = (owner: EditorOwner): string => JSON.stringify(owner)

const decodeOwner = (text: unknown): Option.Option<EditorOwner> =>
  typeof text !== 'string'
    ? Option.none()
    : Result.match(
        Result.try({
          try: (): unknown => JSON.parse(text),
          catch: () => 'invalid',
        }),
        {
          onFailure: () => Option.none(),
          onSuccess: Schema.decodeUnknownOption(EditorOwner),
        },
      )

const detailOf = (event: Event): Readonly<Record<string, unknown>> => {
  const detail: unknown = Reflect.get(event, 'detail')
  return typeof detail === 'object' && detail !== null
    ? Object.fromEntries(Object.entries(detail))
    : {}
}

export const finalFlushOf = (
  detail: Readonly<Record<string, unknown>>,
): Option.Option<Message> =>
  Option.flatMap(decodeOwner(detail['owner']), owner =>
    typeof detail['content'] === 'string' &&
    typeof detail['version'] === 'number' &&
    Number.isInteger(detail['version'])
      ? Option.some(
          Message.FlushedRichText({
            scope: owner.scope,
            sectionKey: owner.sectionKey,
            steps: owner.steps,
            itemId: owner.itemId,
            content: detail['content'],
            version: detail['version'],
          }),
        )
      : Option.none(),
  )

const editorEvents: Dom.TypedEventTarget<{
  [EDITOR_FINAL_EVENT]: CustomEvent<unknown>
  [EDITOR_UPLOAD_CANCELLED_EVENT]: CustomEvent<unknown>
}> = window

export const subscriptions = Subscription.make<Model, Message>()(entry => ({
  // NOTE: Leaving the page with edits that are not saved asks first. It stays
  // on for as long as there are such edits, whatever screen is open.
  unsavedEdits: entry(
    { hasUnsavedEdits: Schema.Boolean },
    {
      modelToDependencies: model => ({
        hasUnsavedEdits: hasUnsavedEdits(model),
      }),
      dependenciesToStream: ({ hasUnsavedEdits: isUnsaved }) =>
        Dom.streamFromEventFilterMapPreventDefault({
          target: window,
          type: 'beforeunload',
          filterMapEvent: () => Option.some(Message.WarnedBeforeLeaving()),
        }).pipe(Stream.when(Effect.sync(() => isUnsaved))),
    },
  ),
  connection: Subscription.persistentEntry(
    Stream.merge(
      Dom.streamFromEvent({
        target: window,
        type: 'online',
        mapEvent: () => Message.ChangedConnection({ isOnline: true }),
      }),
      Dom.streamFromEvent({
        target: window,
        type: 'offline',
        mapEvent: () => Message.ChangedConnection({ isOnline: false }),
      }),
    ),
  ),
  // NOTE: An editor that goes away sends what it still holds, and says when a
  // picture it was sending was cancelled, as events on the window: its own
  // listeners are gone by then. The scope in `owner` drops them if the page
  // was left meanwhile. Not tied to the route, because it is exactly when the
  // route changes that they are sent.
  editorFarewell: Subscription.persistentEntry(
    Stream.merge(
      Dom.streamFromEventFilterMap({
        target: editorEvents,
        type: EDITOR_FINAL_EVENT,
        filterMapEvent: event => finalFlushOf(detailOf(event)),
      }),
      Dom.streamFromEventFilterMap({
        target: editorEvents,
        type: EDITOR_UPLOAD_CANCELLED_EVENT,
        filterMapEvent: event =>
          Option.map(decodeOwner(detailOf(event)['owner']), owner =>
            Message.CancelledImageUpload({ scope: owner.scope }),
          ),
      }),
    ),
  ),
  // NOTE: "Who is drafting" is read again every 30 seconds while the report is
  // open and loaded.
  drafting: entry(
    { isLoaded: Schema.Boolean },
    {
      modelToDependencies: model => ({
        isLoaded: LoadState.guards.Loaded(model.load),
      }),
      dependenciesToStream: ({ isLoaded }) =>
        Stream.tick(Duration.seconds(DRAFTING_REFRESH_SECONDS)).pipe(
          Stream.map(() => Message.TickedDraftingRefresh()),
          Stream.when(Effect.sync(() => isLoaded)),
        ),
    },
  ),
  roundClock: entry(
    { isLoaded: Schema.Boolean },
    {
      modelToDependencies: model => ({
        isLoaded: LoadState.guards.Loaded(model.load),
      }),
      dependenciesToStream: ({ isLoaded }) =>
        Stream.tick(Duration.seconds(ROUND_CLOCK_SECONDS)).pipe(
          Stream.mapEffect(() => Clock.currentTimeMillis),
          Stream.map(nowMs => Message.TickedRoundClock({ nowMs })),
          Stream.when(Effect.sync(() => isLoaded)),
        ),
    },
  ),
  saveRetry: entry(
    { isRetrying: Schema.Boolean },
    {
      modelToDependencies: model => ({
        isRetrying:
          SaveStatus.guards.Failed(model.save) &&
          model.save.failure._tag === 'Unavailable',
      }),
      dependenciesToStream: ({ isRetrying }) =>
        Stream.tick(Duration.seconds(SAVE_RETRY_SECONDS)).pipe(
          Stream.map(() => Message.TickedSaveRetry()),
          Stream.when(Effect.sync(() => isRetrying)),
        ),
    },
  ),
}))

// VIEW

const INDENT = ['pl-3', 'pl-7', 'pl-11', 'pl-14'] as const

const rowLabel = (row: NumberedSection): string =>
  row.number === undefined ? row.title : `${row.number.full} ${row.title}`

const navigatorRow = (
  row: NumberedSection,
  state: SectionState,
  isSelected: boolean,
  h: HtmlBuilder<Message>,
  className = '',
): Html =>
  h.keyed('li')(
    row.key,
    [h.Class(className)],
    [
      h.button(
        [
          h.Type('button'),
          h.AriaLabel(`${rowLabel(row)}, ${stateText(state)}`),
          ...(isSelected ? [h.AriaCurrent('true')] : []),
          h.Class(
            clsx(
              'flex min-h-11 w-full cursor-pointer items-baseline justify-between gap-3 border-l-2 py-2 pr-3 text-left text-base transition-colors hover:bg-msf-mist',
              INDENT[Math.min(row.depth, INDENT.length) - 1],
              isSelected
                ? 'border-msf-red bg-msf-mist font-medium text-msf-black'
                : 'border-transparent text-msf-ink',
              state === 'ended' && 'italic text-msf-grey',
              focusRing,
            ),
          ),
          h.OnClick(Message.SelectedSection({ key: row.key })),
        ],
        [
          h.span(
            [h.Class('min-w-0 text-pretty')],
            [
              rowLabel(row),
              row.frontMatter
                ? h.span(
                    [h.Class('ml-2 text-sm text-msf-grey')],
                    ['Front matter'],
                  )
                : h.empty,
            ],
          ),
          h.span(
            [h.Class('shrink-0 text-sm text-msf-grey')],
            [stateText(state)],
          ),
        ],
      ),
    ],
  )

const completeCount = (
  outline: Outline,
): Readonly<{ complete: number; total: number }> => ({
  complete: Array.filter(
    outline.rows,
    row => outline.states.get(row.key) === 'complete',
  ).length,
  total: outline.rows.length,
})

const navigator = (
  model: Model,
  outline: Outline,
  selectedKey: string,
  h: HtmlBuilder<Message>,
): Html => {
  const { complete, total } = completeCount(outline)
  return h.div(
    [h.Class('flex flex-col gap-3 md:sticky md:top-4 md:self-start')],
    [
      h.button(
        [
          h.Type('button'),
          h.AriaExpanded(model.isNavigatorOpen),
          h.AriaControls('section-navigator'),
          h.Class(
            clsx(
              'flex min-h-12 w-full cursor-pointer items-center justify-between gap-3 border border-msf-line px-3 text-left text-base font-medium md:hidden',
              focusRing,
            ),
          ),
          h.OnClick(Message.ToggledNavigator()),
        ],
        [
          'Sections',
          h.span(
            [h.Class('text-sm font-normal text-msf-grey')],
            [`${complete} of ${total} complete`],
          ),
        ],
      ),
      h.nav(
        [
          h.Id('section-navigator'),
          h.AriaLabel('Sections'),
          h.Class(clsx(model.isNavigatorOpen ? 'block' : 'hidden', 'md:block')),
        ],
        [
          h.p(
            [h.Class('mb-2 hidden text-sm text-msf-grey md:block')],
            [`${complete} of ${total} sections complete`],
          ),
          h.ul(
            [h.Class('flex flex-col border-y border-msf-line')],
            Array.map(outline.rows, row =>
              navigatorRow(
                row,
                outline.states.get(row.key) ?? 'empty',
                row.key === selectedKey,
                h,
              ),
            ),
          ),
        ],
      ),
    ],
  )
}

const caseValuesOf = (
  model: Model,
  detail: typeof ReportDetail.Type,
): CaseValues => ({
  reference: detail.summary.caseFile.reference,
  unit: model.unitName,
  title: detail.summary.caseFile.title,
})

const guidanceBlock = (text: string, h: HtmlBuilder<Message>): Html =>
  h.aside(
    [
      h.AriaLabel('Guidance'),
      h.Class('border-l-2 border-msf-line bg-msf-mist px-4 py-3'),
    ],
    [
      h.p([h.Class('text-sm font-medium text-msf-grey')], ['Guidance']),
      h.p([h.Class('text-pretty text-base italic text-msf-ink')], [text]),
    ],
  )

const sectionNoun = (section: Section): string => section.title.toLowerCase()

// NOTE: *Not applicable* on a section: the control that opens the form, the
// form, or the notice that replaces what the section holds (which is kept).
const sectionNotApplicable = (
  model: Model,
  section: Section,
  sectionKey: string,
  label: string,
  isDisabled: boolean,
  h: HtmlBuilder<Message>,
): Html => {
  if (section.requirement !== 'optional_with_reason') {
    return h.empty
  }
  const target = sectionTarget(sectionKey)
  const reason = notApplicableReasonOf(model.contents, sectionKey)
  const draft = Option.fromNullishOr(model.naDrafts[targetId(target)])
  return Option.match(draft, {
    onSome: form =>
      notApplicableForm(h, {
        id: targetId(target),
        label,
        reason: form.reason,
        isMissing: form.isMissing,
        onType: text => Message.TypedNotApplicableReason({ target, text }),
        onSubmit: Message.SubmittedNotApplicable({ target }),
        onCancel: Message.CancelledNotApplicable({ target }),
      }),
    onNone: () =>
      reason === undefined
        ? isDisabled
          ? h.empty
          : notApplicableButton(
              h,
              label,
              Message.OpenedNotApplicable({ target, reason: '' }),
            )
        : notApplicableNotice(h, {
            label,
            reason,
            isDisabled,
            onEdit: Message.OpenedNotApplicable({ target, reason }),
            onRestore: Message.RestoredApplicable({ target }),
            keeps:
              'What was written here is kept and comes back if you mark this as applicable again.',
          }),
  })
}

const entryRowsOf = (
  rows: ReadonlyArray<NumberedSection>,
  parentKey: string,
  sectionId: string,
): ReadonlyArray<NumberedSection> =>
  Array.filter(
    rows,
    row =>
      row.parentKey === parentKey &&
      row.sectionId === sectionId &&
      row.entryId !== undefined,
  )

const groupCard = (
  model: Model,
  child: Section,
  parentKey: string,
  outline: Outline,
  isDisabled: boolean,
  h: HtmlBuilder<Message>,
): Html => {
  const groupKey = childKeyOf(parentKey, child.id)
  const target = sectionTarget(groupKey)
  const limits = sectionLimits(child)
  const entryRows = entryRowsOf(outline.rows, parentKey, child.id)
  const reason = notApplicableReasonOf(model.contents, groupKey)
  const naNode = sectionNotApplicable(
    model,
    child,
    groupKey,
    child.title,
    isDisabled,
    h,
  )
  const showsNaFirst =
    reason !== undefined || model.naDrafts[targetId(target)] !== undefined
  return h.keyed('li')(
    child.id,
    [h.Class('flex flex-col gap-3 py-4'), h.DataAttribute('group', child.id)],
    [
      h.h4([h.Class('text-lg font-bold')], [child.title]),
      showsNaFirst ? naNode : h.empty,
      reason !== undefined
        ? h.empty
        : h.div(
            [h.Class('flex flex-col gap-3')],
            [
              countLine(
                h,
                countText(entryRows.length, limits, sectionNoun(child)),
              ),
              Array.match(entryRows, {
                onEmpty: () => h.empty,
                onNonEmpty: list =>
                  h.ol(
                    [
                      h.AriaLabel(child.title),
                      h.Class('flex flex-col border-y border-msf-line'),
                    ],
                    Array.map(list, (row, index) =>
                      h.keyed('li')(
                        row.key,
                        [h.Class('flex flex-col gap-2 py-2')],
                        [
                          navigatorRow(
                            { ...row, depth: 1 },
                            outline.states.get(row.key) ?? 'empty',
                            false,
                            h,
                            'list-none',
                          ),
                          isDisabled
                            ? h.empty
                            : entryControls(h, {
                                label: row.title,
                                canMoveUp: index > 0,
                                canMoveDown: index < list.length - 1,
                                onMoveUp: Message.ClickedMoveEntry({
                                  target,
                                  entryId: row.entryId ?? '',
                                  step: -1,
                                }),
                                onMoveDown: Message.ClickedMoveEntry({
                                  target,
                                  entryId: row.entryId ?? '',
                                  step: 1,
                                }),
                                onRemove: Message.ClickedRemoveEntry({
                                  target,
                                  entryId: row.entryId ?? '',
                                  label: row.title,
                                }),
                              }),
                        ],
                      ),
                    ),
                  ),
              }),
              isDisabled
                ? h.empty
                : addButton(
                    h,
                    `Add ${sectionNoun(child)}`,
                    Message.ClickedAddEntry({ target }),
                    !canAdd(entryRows.length, limits),
                  ),
              showsNaFirst ? h.empty : naNode,
            ],
          ),
    ],
  )
}

const subsectionList = (
  section: Section,
  sectionKey: string,
  model: Model,
  outline: Outline,
  isDisabled: boolean,
  h: HtmlBuilder<Message>,
): Html =>
  Array.match(section.sections, {
    onEmpty: () => h.empty,
    onNonEmpty: children =>
      h.nav(
        [h.AriaLabel('Subsections'), h.Class('flex flex-col gap-2')],
        [
          h.h3([h.Class('text-lg font-bold')], ['Subsections']),
          h.ul(
            [
              h.Class(
                'flex flex-col divide-y divide-msf-line border-y border-msf-line',
              ),
            ],
            Array.map(children, child =>
              child.repeat !== undefined
                ? groupCard(model, child, sectionKey, outline, isDisabled, h)
                : Option.match(
                    Array.findFirst(
                      outline.rows,
                      row =>
                        row.sectionId === child.id &&
                        row.parentKey === sectionKey &&
                        row.entryId === undefined,
                    ),
                    {
                      onNone: () => h.keyed('li')(child.id, []),
                      onSome: row =>
                        navigatorRow(
                          { ...row, depth: 1 },
                          outline.states.get(row.key) ?? 'empty',
                          false,
                          h,
                        ),
                    },
                  ),
            ),
          ),
        ],
      ),
  })

const stepButtons = (
  rows: ReadonlyArray<NumberedSection>,
  selectedKey: string,
  h: HtmlBuilder<Message>,
): Html => {
  const index = Array.findFirstIndex(rows, row => row.key === selectedKey)
  const previous = Option.flatMap(index, at => Array.get(rows, at - 1))
  const next = Option.flatMap(index, at => Array.get(rows, at + 1))
  return h.div(
    [
      h.Class(
        'flex flex-wrap justify-between gap-3 border-t border-msf-line pt-5',
      ),
    ],
    [
      Option.match(previous, {
        onNone: () => h.empty,
        onSome: row =>
          smallButton(
            h,
            'Previous section',
            Message.SelectedSection({ key: row.key }),
            Option.some(`Previous section: ${rowLabel(row)}`),
          ),
      }),
      Option.match(next, {
        onNone: () => h.empty,
        onSome: row =>
          smallButton(
            h,
            'Next section',
            Message.SelectedSection({ key: row.key }),
            Option.some(`Next section: ${rowLabel(row)}`),
          ),
      }),
    ],
  )
}

// NOTE: One place builds what every field needs, so the sections and entries
// of a report all send the same Messages, named by the key they edit.
const fieldContextFor = (
  model: Model,
  detail: typeof ReportDetail.Type,
  sectionKey: string,
  isDisabled: boolean,
): FieldContext<Message> => ({
  caseValues: caseValuesOf(model, detail),
  people: model.people,
  isDisabled,
  steps: [],
  scope: '',
  onChange: (steps, itemId, maybeValue) =>
    Message.ChangedItem({ sectionKey, steps, itemId, maybeValue }),
  richText: {
    editor: model.editor,
    versionOf: (steps, itemId) =>
      model.editorVersions[richKey(sectionKey, steps, itemId)] ?? 0,
    generation: model.editorGeneration,
    ownerOf: (steps, itemId) =>
      ownerText({ scope: scopeOf(model), sectionKey, steps, itemId }),
    onDiscarded: (steps, itemId, content) =>
      Message.DiscardedRichText({ sectionKey, steps, itemId, content }),
    onChange: (steps, itemId, content, version) =>
      Message.ChangedRichText({ sectionKey, steps, itemId, content, version }),
    onSelection: (_steps, itemId, range) =>
      Message.SelectedRichTextRange({ sectionKey, itemId, ...range }),
    onRetryLoad: Message.ClickedRetryLoadEditor(),
    reportId: model.reportId,
    remaining: Option.match(model.maybeImageUsage, {
      onNone: () => -1,
      onSome: usage => remainingBytes(usage),
    }),
    usageText: Option.match(model.maybeImageUsage, {
      onNone: () => IMAGE_LIMITS_TEXT,
      onSome: usageText,
    }),
    onImage: () => Message.AddedImage(),
  },
  entries: {
    onAdd: (steps, itemId) =>
      Message.ClickedAddEntry({
        target: itemTarget(sectionKey, steps, itemId),
      }),
    onMove: (steps, itemId, entryId, step) =>
      Message.ClickedMoveEntry({
        target: itemTarget(sectionKey, steps, itemId),
        entryId,
        step,
      }),
    onRemove: (steps, itemId, entryId, label) =>
      Message.ClickedRemoveEntry({
        target: itemTarget(sectionKey, steps, itemId),
        entryId,
        label,
      }),
  },
  notApplicable: {
    draftOf: (steps, itemId) =>
      Option.fromNullishOr(
        model.naDrafts[targetId(itemTarget(sectionKey, steps, itemId))],
      ),
    onOpen: (steps, itemId, reason) =>
      Message.OpenedNotApplicable({
        target: itemTarget(sectionKey, steps, itemId),
        reason,
      }),
    onType: (steps, itemId, text) =>
      Message.TypedNotApplicableReason({
        target: itemTarget(sectionKey, steps, itemId),
        text,
      }),
    onSubmit: (steps, itemId) =>
      Message.SubmittedNotApplicable({
        target: itemTarget(sectionKey, steps, itemId),
      }),
    onCancel: (steps, itemId) =>
      Message.CancelledNotApplicable({
        target: itemTarget(sectionKey, steps, itemId),
      }),
    onRestore: (steps, itemId) =>
      Message.RestoredApplicable({
        target: itemTarget(sectionKey, steps, itemId),
      }),
  },
})

const entryHeader = (
  model: Model,
  row: NumberedSection,
  section: Section,
  isDisabled: boolean,
  h: HtmlBuilder<Message>,
): Html => {
  const entryId = row.entryId
  if (entryId === undefined) {
    return h.empty
  }
  const groupKey = groupKeyOf(row.key)
  const target = sectionTarget(groupKey)
  const entries = entriesOfKey(model.contents, groupKey)
  const index = Array.findFirstIndex(entries, entry => entry.id === entryId)
  const stored = entries.find(entry => entry.id === entryId)?.title ?? ''
  return h.div(
    [h.Class('flex flex-col gap-4 border-l-2 border-msf-line pl-4')],
    [
      textField(h, {
        id: `entry-title-${entryId}`,
        label: `Title of this ${sectionNoun(section)}`,
        value: model.titleDrafts[row.key] ?? stored,
        hint: `Optional. Without a title it is called "${section.title} ${Option.match(index, { onNone: () => 1, onSome: at => at + 1 })}".`,
        onInput: text => Message.ChangedEntryTitle({ target, entryId, text }),
      }),
      isDisabled
        ? h.empty
        : entryControls(h, {
            label: row.title,
            canMoveUp: Option.exists(index, at => at > 0),
            canMoveDown: Option.exists(index, at => at < entries.length - 1),
            onMoveUp: Message.ClickedMoveEntry({ target, entryId, step: -1 }),
            onMoveDown: Message.ClickedMoveEntry({ target, entryId, step: 1 }),
            onRemove: Message.ClickedRemoveEntry({
              target,
              entryId,
              label: row.title,
            }),
          }),
    ],
  )
}

const sectionBody = (
  model: Model,
  detail: typeof ReportDetail.Type,
  template: Template,
  outline: Outline,
  row: NumberedSection,
  section: Section,
  h: HtmlBuilder<Message>,
): ReadonlyArray<Html> => {
  const state = outline.states.get(row.key) ?? 'empty'
  const access = editability(
    template,
    detail.summary.state,
    detail.permissions,
    topSectionIdOfKey(row.key),
  )
  const isDisabled = access.kind === 'read_only'
  const values = contentOfKey(model.contents, row.key).values
  const reason =
    row.entryId === undefined
      ? notApplicableReasonOf(model.contents, row.key)
      : undefined
  const context = fieldContextFor(model, detail, row.key, isDisabled)
  const naNode =
    row.entryId === undefined
      ? sectionNotApplicable(
          model,
          section,
          row.key,
          section.title,
          isDisabled,
          h,
        )
      : h.empty
  return [
    ...(section.instruction === undefined
      ? []
      : [guidanceBlock(section.instruction, h)]),
    state === 'ended'
      ? h.p(
          [h.Role('status'), h.Class('text-lg text-msf-ink')],
          [
            'This section is not in force: the report ended earlier. What it holds is kept and comes back if the answer that ended the report changes.',
          ],
        )
      : h.div(
          [h.Class('flex flex-col gap-6')],
          [
            isDisabled
              ? h.p(
                  [h.Class('text-base text-msf-grey')],
                  [access.kind === 'read_only' ? access.reason : ''],
                )
              : h.empty,
            entryHeader(model, row, section, isDisabled, h),
            naNode,
            reason !== undefined
              ? h.empty
              : h.div(
                  [h.Class('flex flex-col gap-6')],
                  Array.map(section.items, item =>
                    itemField(h, context, item, values[item.id]),
                  ),
                ),
          ],
        ),
  ]
}

const sectionView = (
  model: Model,
  detail: typeof ReportDetail.Type,
  template: Template,
  outline: Outline,
  selectedKey: string,
  h: HtmlBuilder<Message>,
): Html =>
  Option.match(
    Array.findFirst(outline.rows, row => row.key === selectedKey),
    {
      onNone: () =>
        h.p(
          [h.Class('text-lg text-msf-grey')],
          ['This template has no sections.'],
        ),
      onSome: row =>
        h.section(
          [h.AriaLabel('Section'), h.Class('flex min-w-0 flex-col gap-6')],
          [
            h.div(
              [h.Class('flex flex-col gap-1')],
              [
                h.h2(
                  [
                    h.Id(SECTION_HEADING_ID),
                    h.Class('text-balance text-3xl font-black tracking-tight'),
                  ],
                  [rowLabel(row)],
                ),
                h.p(
                  [h.Class('text-base text-msf-grey')],
                  [stateText(outline.states.get(row.key) ?? 'empty')],
                ),
              ],
            ),
            ...(model.view === 'redacted'
              ? [
                  h.p(
                    [h.Class('text-base text-msf-ink')],
                    [viewNote('redacted')],
                  ),
                  previewSection(
                    h,
                    {
                      template,
                      people: model.people,
                      contents: model.contents,
                      reportId: model.reportId,
                      caseTitle: detail.summary.caseFile.title,
                    },
                    'redacted',
                    topSectionIdOfKey(row.key),
                  ),
                ]
              : []),
            ...(model.view === 'redacted'
              ? []
              : Option.match(
                  Option.fromNullishOr(sectionOfKey(template, row.key)),
                  {
                    onNone: () => [
                      h.p(
                        [h.Class('text-base text-msf-grey')],
                        ['This section is no longer in the report.'],
                      ),
                    ],
                    onSome: section => [
                      ...sectionBody(
                        model,
                        detail,
                        template,
                        outline,
                        row,
                        section,
                        h,
                      ),
                      notApplicableReasonOf(model.contents, row.key) !==
                        undefined && row.entryId === undefined
                        ? h.empty
                        : subsectionList(
                            section,
                            row.key,
                            model,
                            outline,
                            editability(
                              template,
                              detail.summary.state,
                              detail.permissions,
                              topSectionIdOfKey(row.key),
                            ).kind === 'read_only',
                            h,
                          ),
                    ],
                  },
                )),
            stepButtons(outline.rows, selectedKey, h),
          ],
        ),
    },
  )

const refusalNote = (model: Model, h: HtmlBuilder<Message>): Html =>
  Option.match(
    Option.orElse(model.maybeRefusal, () => model.maybeEditNote),
    {
      onNone: () => h.empty,
      onSome: reason =>
        h.p(
          [h.Role('alert'), h.Class('text-base font-medium text-msf-alert')],
          [reason],
        ),
    },
  )

const savedText = (model: Model): string =>
  Option.match(model.maybeSavedAt, {
    onNone: () => 'Saved',
    onSome: at => `Saved at ${timeText(at)}`,
  })

const saveIndicator = (model: Model, h: HtmlBuilder<Message>): Html => {
  const counter = h.span(
    [h.Class('text-sm font-normal text-msf-grey')],
    [`Save ${model.saveCounter}`],
  )
  const line = (text: string): Html =>
    h.div(
      [h.Class('flex flex-wrap items-baseline gap-3')],
      [statusText(h, text), counter],
    )
  return SaveStatus.match(model.save, {
    Saved: () =>
      !model.isOnline
        ? line('Offline')
        : Array.isReadonlyArrayEmpty(model.dirtySectionIds)
          ? line(savedText(model))
          : line('Saving…'),
    Saving: () => (model.isOnline ? line('Saving…') : line('Offline')),
    Failed: ({ failure }) =>
      h.div(
        [h.Class('flex flex-wrap items-baseline gap-3')],
        [
          h.p(
            [h.Role('alert'), h.Class('text-base font-medium text-msf-alert')],
            [
              failure._tag === 'Unavailable'
                ? 'Not saved — retrying'
                : failureText(failure),
            ],
          ),
          smallButton(h, 'Try saving again', Message.ClickedRetrySave()),
          counter,
        ],
      ),
    Stale: () => line('Not saved'),
  })
}

const staleBanner = (model: Model, h: HtmlBuilder<Message>): Html =>
  SaveStatus.guards.Stale(model.save)
    ? h.section(
        [
          h.AriaLabel('This working copy changed in another tab'),
          h.Role('alert'),
          h.Class('flex flex-col gap-3 border-2 border-msf-red px-4 py-4'),
        ],
        [
          h.h2(
            [h.Class('text-xl font-black')],
            ['This working copy changed in another tab'],
          ),
          h.p(
            [h.Class('text-pretty text-base text-msf-ink')],
            [
              'Your last edit was not saved, so nothing saved in the other tab was overwritten. Reload the saved version. Your edit is kept here, and you can copy it or put it back.',
            ],
          ),
          actionButton(
            h,
            model.isReloading ? 'Reloading…' : 'Reload the saved version',
            'Reload the saved version',
            Message.ClickedReloadWorkingCopy(),
            model.isReloading,
          ),
        ],
      )
    : h.empty

const keptEditsPanel = (
  model: Model,
  template: Template,
  h: HtmlBuilder<Message>,
): Html =>
  Array.match(model.keptEdits, {
    onEmpty: () => h.empty,
    onNonEmpty: edits =>
      h.section(
        [
          h.AriaLabel('Edits that were not saved'),
          h.Class('flex flex-col gap-4 border-2 border-msf-ink px-4 py-4'),
        ],
        [
          h.h2([h.Class('text-xl font-black')], ['Edits that were not saved']),
          h.p(
            [h.Class('text-base text-msf-grey')],
            [
              'These were typed here, but the working copy had changed in another tab. Copy the text, or put the whole section back as you had it.',
            ],
          ),
          ...Array.map(edits, edit => {
            const title = Array.findFirst(
              topLevelSections(template),
              section => section.id === edit.sectionId,
            ).pipe(
              Option.map(section => section.title),
              Option.getOrElse(() => edit.sectionId),
            )
            return h.keyed('div')(
              edit.sectionId,
              [
                h.Class('flex flex-col gap-2'),
                h.DataAttribute('kept', edit.sectionId),
              ],
              [
                h.label(
                  [
                    h.Class('text-base font-medium'),
                    h.For(`kept-${edit.sectionId}`),
                  ],
                  [title],
                ),
                h.textarea([
                  h.Id(`kept-${edit.sectionId}`),
                  h.Readonly(true),
                  h.Value(
                    contentTexts({
                      schemaVersion: CONTENT_SCHEMA_VERSION,
                      templateId: template.id,
                      templateVersion: template.version,
                      sections: { [edit.sectionId]: edit.content },
                    }).join('\n\n'),
                  ),
                  h.Class(
                    'min-h-32 w-full border border-msf-line bg-white px-3 py-2 text-base',
                  ),
                ]),
                h.div(
                  [h.Class('flex flex-wrap gap-2')],
                  [
                    actionButton(
                      h,
                      'Put my version back',
                      `Put my version of ${title} back`,
                      Message.ClickedReapplyEdit({ sectionId: edit.sectionId }),
                    ),
                    actionButton(
                      h,
                      'Discard my version',
                      `Discard my version of ${title}`,
                      Message.ClickedDiscardEdit({ sectionId: edit.sectionId }),
                    ),
                  ],
                ),
              ],
            )
          }),
        ],
      ),
  })

const confirmationPanel = (model: Model, h: HtmlBuilder<Message>): Html =>
  Option.match(model.maybeConfirmation, {
    onNone: () => h.empty,
    onSome: confirmation => {
      const [heading, text, yes, onYes] = Confirmation.match(confirmation, {
        RemoveEntry: ({ label }) =>
          [
            `Remove ${label}?`,
            'What was written in it is removed from this working copy.',
            'Remove',
            Message.ConfirmedRemoveEntry(),
          ] as const,
        ReapplyEdit: ({ title }) =>
          [
            `Put your version of ${title} back?`,
            `This replaces the version of ${title} that was saved in the other tab with the one you typed here. What the other tab saved in this section is lost.`,
            'Replace the saved version',
            Message.ConfirmedReapplyEdit(),
          ] as const,
        StartConclusion: () =>
          [
            'Start the conclusion?',
            'From now on only the conclusion section can be edited. Every other section becomes read-only, and only a closing revision can be published.',
            'Start the conclusion',
            Message.ConfirmedStartConclusion(),
          ] as const,
        ReplaceCopy: () =>
          [
            'Start again from the latest shared draft?',
            'Everything in this working copy that is not shared is discarded, and the working copy starts again from the latest shared draft.',
            'Discard and start again',
            Message.ConfirmedReplaceCopy(),
          ] as const,
      })
      return h.section(
        [
          h.AriaLabel(heading),
          h.Role('alertdialog'),
          h.Class('flex flex-col gap-3 border-2 border-msf-ink px-4 py-4'),
        ],
        [
          h.h2(
            [
              h.Id(CONFIRMATION_ID),
              h.Tabindex(-1),
              h.Class('text-xl font-black'),
            ],
            [heading],
          ),
          h.p([h.Class('text-pretty text-base text-msf-ink')], [text]),
          h.div(
            [h.Class('flex flex-wrap gap-2')],
            [
              actionButton(h, yes, yes, onYes),
              actionButton(
                h,
                'Cancel',
                'Cancel',
                Message.CancelledConfirmation(),
              ),
            ],
          ),
        ],
      )
    },
  })

const sharePrompt = (
  model: Model,
  copy: CopyInfo,
  h: HtmlBuilder<Message>,
): Html =>
  Option.match(model.maybeDetail, {
    onNone: () => h.empty,
    onSome: detail =>
      !Array.contains(detail.permissions, 'share') ||
      detail.summary.state === 'archived'
        ? h.empty
        : hasUnsavedEdits(model)
          ? h.p(
              [h.Role('status'), h.Class('text-base text-msf-grey')],
              ['Sharing is available once everything is saved.'],
            )
          : h.a(
              [
                h.Href(pathOf(AppRoute.Share({ reportId: model.reportId }))),
                h.Class(
                  clsx(
                    'inline-flex min-h-11 items-center self-start border border-msf-ink px-4 text-base font-medium text-msf-ink hover:bg-msf-mist',
                    focusRing,
                  ),
                ),
              ],
              [
                copy.behind
                  ? `Compare and share as Draft ${copy.latestDraft + 1}`
                  : `Share as Draft ${copy.latestDraft + 1}`,
              ],
            ),
  })

const outcomeBanner = (
  model: Model,
  detail: typeof ReportDetail.Type,
  template: Template,
  h: HtmlBuilder<Message>,
): Html =>
  Option.match(
    outcomeOf(
      template,
      detail.summary.state,
      model.revisions,
      detail.permissions,
    ),
    {
      onNone: () => h.empty,
      onSome: outcome =>
        outcomeView(
          h,
          model.reportId,
          outcome,
          Message.ClickedStartConclusion(),
        ),
    },
  )

// NOTE: The review rounds of the report (D11, D18): the open round with its
// deadline and countdown, every revision with its status, and the way to
// publish the next one. The countdown is read from a clock the screen ticks.
const reviewPanel = (
  model: Model,
  detail: typeof ReportDetail.Type,
  h: HtmlBuilder<Message>,
): Html => {
  const canPublish =
    Array.contains(detail.permissions, 'publish') &&
    (detail.summary.state === 'drafting' || detail.summary.state === 'in_review')
  return Array.isReadonlyArrayEmpty(model.revisions) && !canPublish
    ? h.empty
    : panel(
        h,
        'Review',
        [
          Option.match(currentRoundOf(model.revisions), {
            onNone: () =>
              h.p(
                [h.Class('text-lg text-msf-ink')],
                [
                  Array.isReadonlyArrayEmpty(model.revisions)
                    ? 'Nothing has been published for review yet.'
                    : 'No round is open.',
                ],
              ),
            onSome: revision =>
              h.p(
                [
                  h.Role('status'),
                  h.DataAttribute('current-round', String(revision.number)),
                  h.Class('text-lg font-medium text-msf-ink'),
                ],
                [
                  `${revision.label} is open. ${roundLine(revision, model.nowMs)}`,
                ],
              ),
          }),
          revisionsList(h, model.revisions, model.nowMs),
          canPublish
            ? h.a(
                [
                  h.Href(
                    pathOf(AppRoute.Publish({ reportId: model.reportId })),
                  ),
                  h.Class(
                    clsx(
                      'inline-flex min-h-11 items-center self-start border border-msf-ink px-4 text-base font-medium text-msf-ink hover:bg-msf-mist',
                      focusRing,
                    ),
                  ),
                ],
                ['Publish for review'],
              )
            : h.empty,
          Array.isReadonlyArrayEmpty(model.revisions)
            ? h.empty
            : h.a(
                [
                  h.Href(
                    pathOf(AppRoute.Comments({ reportId: model.reportId })),
                  ),
                  h.Class(
                    clsx(
                      'inline-flex min-h-11 items-center self-start border border-msf-ink px-4 text-base font-medium text-msf-ink hover:bg-msf-mist',
                      focusRing,
                    ),
                  ),
                ],
                ['Comments from reviewers'],
              ),
          Array.isReadonlyArrayEmpty(model.revisions)
            ? h.empty
            : h.a(
                [
                  h.Href(pathOf(AppRoute.Grid({ reportId: model.reportId }))),
                  h.Class(
                    clsx(
                      'inline-flex min-h-11 items-center self-start border border-msf-ink px-4 text-base font-medium text-msf-ink hover:bg-msf-mist',
                      focusRing,
                    ),
                  ),
                ],
                ['Status grid'],
              ),
          h.a(
            [
              h.Href(pathOf(AppRoute.Audit({ reportId: model.reportId }))),
              h.Class(
                clsx(
                  'inline-flex min-h-11 items-center self-start border border-msf-ink px-4 text-base font-medium text-msf-ink hover:bg-msf-mist',
                  focusRing,
                ),
              ),
            ],
            ['Audit log'],
          ),
          h.a(
            [
              h.Href(pathOf(AppRoute.Downloads({ reportId: model.reportId }))),
              h.Class(
                clsx(
                  'inline-flex min-h-11 items-center self-start border border-msf-ink px-4 text-base font-medium text-msf-ink hover:bg-msf-mist',
                  focusRing,
                ),
              ),
            ],
            ['Downloads'],
          ),
        ],
        Option.some(
          'Only the latest revision counts. A new revision replaces the open round.',
        ),
      )
}

const workingCopyPanel = (model: Model, h: HtmlBuilder<Message>): Html =>
  Option.match(model.maybeCopy, {
    onNone: () => h.empty,
    onSome: copy =>
      panel(
        h,
        'Your working copy',
        [
          h.p(
            [h.Class('text-base text-msf-ink')],
            [
              `Started from draft ${copy.baseDraft}. The latest shared draft is ${copy.latestDraft}.`,
            ],
          ),
          sharePrompt(model, copy, h),
          copy.latestDraft >= 1
            ? actionButton(
                h,
                'Start again from the latest shared draft',
                'Start again from the latest shared draft',
                Message.ClickedReplaceCopy(),
              )
            : h.empty,
        ],
        Option.some(
          copy.behind
            ? 'A draft was shared after your working copy started.'
            : 'Your working copy starts from the latest shared draft.',
        ),
      ),
  })

// NOTE: Other authors' working copies: which draft each started from and when
// each was last saved, with a mark for changes not shared yet. Names are
// authors of this report only; no text of a working copy is shown.
export const draftingLine = (entry: typeof DraftingInfo.Type): string =>
  `${entry.name} is working from Draft ${entry.baseDraft}, last saved ${timeText(entry.lastSavedAt)}${entry.hasUnsharedChanges ? '' : ', nothing new to share'}.`

const draftingPanel = (model: Model, h: HtmlBuilder<Message>): Html => {
  const others = Array.filter(
    model.drafting,
    entry => entry.accountId !== model.myId,
  )
  return panel(
    h,
    'Who is drafting',
    [
      Array.match(others, {
        onEmpty: () =>
          h.p(
            [h.Class('text-lg text-msf-grey')],
            ['No other author has a working copy of this report.'],
          ),
        onNonEmpty: list =>
          h.ul(
            [
              h.AriaLabel('Other authors drafting'),
              h.Class(
                'flex flex-col divide-y divide-msf-line border-y border-msf-line',
              ),
            ],
            Array.map(list, entry =>
              h.keyed('li')(
                entry.accountId,
                [
                  h.Class('py-3 text-lg text-msf-ink'),
                  h.DataAttribute('drafting', entry.accountId),
                ],
                [draftingLine(entry)],
              ),
            ),
          ),
      }),
      h.a(
        [
          h.Href(pathOf(AppRoute.Drafts({ reportId: model.reportId }))),
          h.Class(clsx('self-start text-lg text-msf-ink underline', focusRing)),
        ],
        ['Draft history'],
      ),
    ],
    Option.some('Updated every 30 seconds while this page is open.'),
  )
}

const endedBanner = (end: EndState, h: HtmlBuilder<Message>): Html =>
  end.outcomeText === undefined
    ? h.empty
    : h.section(
        [
          h.AriaLabel('The report ends here'),
          h.Class('flex flex-col gap-2 border-2 border-msf-ink px-4 py-4'),
        ],
        [
          h.h2([h.Class('text-xl font-black')], ['The report ends here']),
          h.p([h.Class('text-pretty text-lg')], [end.outcomeText]),
          h.p(
            [h.Class('text-base text-msf-grey')],
            [
              'Later required sections are marked as ended. If the answer that ended the report changes, they come back with what they held.',
            ],
          ),
        ],
      )

const authorsPanel = (
  model: Model,
  detail: typeof ReportDetail.Type,
  h: HtmlBuilder<Message>,
): Html => {
  const candidates = authorCandidates(model)
  return panel(
    h,
    'Authors of this report',
    [
      h.ul(
        [
          h.AriaLabel('Authors of this report'),
          h.Class(
            'flex flex-col divide-y divide-msf-line border-y border-msf-line',
          ),
        ],
        Array.map(detail.authors, author =>
          h.keyed('li')(author.id, [h.Class('py-3 text-lg')], [author.name]),
        ),
      ),
      Option.match(model.maybeNotice, {
        onNone: () => h.empty,
        onSome: notice => statusText(h, notice),
      }),
      Array.contains(detail.permissions, 'manage_people')
        ? Array.match(candidates, {
            onEmpty: () =>
              h.p(
                [h.Class('text-base text-msf-grey')],
                [
                  'Every author of this unit is already on this report. An administrator grants the author capability to others.',
                ],
              ),
            onNonEmpty: people =>
              h.form(
                [
                  h.Class('flex max-w-md flex-col gap-4'),
                  h.AriaLabel('Add a co-author'),
                  h.OnSubmit(Message.SubmittedCoAuthor()),
                ],
                [
                  selectField(
                    h,
                    'co-author-choice',
                    'Add a co-author',
                    model.coAuthorChoice,
                    [
                      { value: '', label: 'Choose an author' },
                      ...Array.map(people, member => ({
                        value: member.accountId,
                        label: member.name,
                      })),
                    ],
                    value => Message.SelectedCoAuthor({ value }),
                  ),
                  formStatus(h, model.coAuthorForm, 'Adding.'),
                  submitButton(
                    h,
                    'Add co-author',
                    isSubmitting(model.coAuthorForm),
                    'Adding…',
                  ),
                ],
              ),
          })
        : h.empty,
    ],
    Option.some(
      'Co-authors are chosen from the existing authors of the unit. An administrator grants the author capability.',
    ),
  )
}

const loadedView = (
  model: Model,
  detail: typeof ReportDetail.Type,
  template: Template,
  h: HtmlBuilder<Message>,
): Html => {
  const outline = outlineOf(template, model)
  const selectedKey = selectedKeyOf(model, outline.rows)
  return h.section(
    [
      h.AriaLabel('Report'),
      h.Class('flex flex-col gap-8 pb-14 pt-8 md:pb-20 md:pt-12'),
    ],
    [
      h.div(
        [h.Class('flex flex-col gap-3')],
        [
          h.a(
            [
              h.Href(pathOf(AppRoute.Reports())),
              h.Class(
                clsx('self-start text-base text-msf-ink underline', focusRing),
              ),
            ],
            ['All reports'],
          ),
          h.h1(
            [
              h.Id('page-heading'),
              h.Class(
                'text-balance text-3xl font-black leading-[1.05] tracking-[-0.025em] text-msf-black sm:text-4xl',
              ),
            ],
            [template.name],
          ),
          h.p(
            [h.Class('text-pretty text-lg text-msf-ink')],
            [
              `${detail.summary.caseFile.reference}: ${detail.summary.caseFile.title}`,
            ],
          ),
          h.p(
            [h.Class('text-base text-msf-grey')],
            [
              `${reportStateText(detail.summary.state)} · Draft ${detail.summary.latestDraft}`,
            ],
          ),
          saveIndicator(model, h),
          refusalNote(model, h),
        ],
      ),
      staleBanner(model, h),
      keptEditsPanel(model, template, h),
      confirmationPanel(model, h),
      outcomeBanner(model, detail, template, h),
      endedBanner(outline.end, h),
      h.div(
        [h.Class('flex flex-wrap items-center gap-4')],
        [
          viewToggle(h, model.view, view => Message.ChoseView({ view })),
          h.a(
            [
              h.Href(pathOf(AppRoute.Names({ reportId: model.reportId }))),
              h.Class(
                clsx(
                  'inline-flex min-h-10 items-center border border-msf-ink px-4 text-base font-medium text-msf-ink hover:bg-msf-mist',
                  focusRing,
                ),
              ),
            ],
            [`People and names (${model.people.length})`],
          ),
        ],
      ),
      h.div(
        [
          h.Class(
            'flex flex-col gap-8 md:grid md:grid-cols-[18rem_minmax(0,1fr)] md:gap-10',
          ),
        ],
        [
          navigator(model, outline, selectedKey, h),
          sectionView(model, detail, template, outline, selectedKey, h),
        ],
      ),
      reviewPanel(model, detail, h),
      workingCopyPanel(model, h),
      draftingPanel(model, h),
      authorsPanel(model, detail, h),
    ],
  )
}

const shell = (children: ReadonlyArray<Html>, h: HtmlBuilder<Message>): Html =>
  h.section(
    [
      h.AriaLabel('Report'),
      h.Class('flex max-w-3xl flex-col gap-6 pb-14 pt-10 md:pt-14'),
    ],
    [
      h.h1(
        [
          h.Id('page-heading'),
          h.Class('text-4xl font-black tracking-[-0.025em] text-msf-black'),
        ],
        ['Report'],
      ),
      ...children,
    ],
  )

export const view = Submodel.defineView<Model, Message>((model, h) =>
  LoadState.match(model.load, {
    Loading: () => shell([loadingText(h, 'Loading the report.')], h),
    Failed: ({ failure }) =>
      shell(
        [
          failure._tag === 'NotAllowed'
            ? h.p(
                [
                  h.Role('alert'),
                  h.Class('text-lg font-medium text-msf-alert'),
                ],
                ['This report is not available to you.'],
              )
            : failureAlert(h, failure),
          smallButton(h, 'Try again', Message.ClickedRetryLoad()),
        ],
        h,
      ),
    Loaded: () =>
      Option.match(
        Option.all({
          detail: model.maybeDetail,
          template: model.maybeTemplate,
        }),
        {
          onNone: () => shell([loadingText(h, 'Loading the report.')], h),
          onSome: ({ detail, template }) =>
            loadedView(model, detail, template, h),
        },
      ),
  }),
)
