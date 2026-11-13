import { BrowserCrypto } from '@effect/platform-browser'
import { clsx } from 'clsx'
import {
  Array,
  Crypto,
  Duration,
  Effect,
  Option,
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
  type EndState,
  type ItemStep,
  ItemValue,
  type NumberedSection,
  PeopleList,
  type Permission,
  ReportDetail,
  type ReportState,
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

import { AppRoute, pathOf } from '../route'
import { focusRing } from '../style'
import { type QuoroomClient, withQuoroom } from './api'
import {
  EMPTY_RICH_TEXT_JSON,
  parseRichTextJson,
  serializeRichText,
} from './editor/richText'
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
import { IMAGE_LIMITS_TEXT, remainingBytes, usageText } from './images/plan'
import { FormState, formStatus, isSubmitting } from './formState'
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
})
export type Confirmation = typeof Confirmation.Type

export const Model = Schema.Struct({
  origin: Schema.String,
  reportId: Schema.String,
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
  editorBase: Schema.Int,
})
export type Model = typeof Model.Type

export const initialModel = Model.make({
  origin: '',
  reportId: '',
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
  editorBase: 0,
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
})
export type LoadedReport = typeof LoadedReport.Type

// MESSAGE

export const Message = defineMessageUnion({
  SucceededLoadReport: { loaded: LoadedReport },
  FailedLoadReport: { failure: Failure },
  ClickedRetryLoad: {},
  SelectedSection: { key: Schema.String },
  ToggledNavigator: {},
  ChangedItem: {
    sectionKey: Schema.String,
    steps: Schema.Array(StepSchema),
    itemId: Schema.String,
    maybeValue: Schema.Option(ItemValue),
  },
  SucceededSaveSection: {
    sectionId: Schema.String,
    saveCounter: Schema.Int,
    savedAt: Schema.Int,
  },
  FailedSaveSection: { sectionId: Schema.String, failure: Failure },
  StaleSaveSection: { sectionId: Schema.String },
  ClickedRetrySave: {},
  TickedSaveRetry: {},
  ChangedConnection: { isOnline: Schema.Boolean },
  WarnedBeforeLeaving: {},
  ClickedReloadWorkingCopy: {},
  SucceededReloadWorkingCopy: {
    contents: Schema.Record(Schema.String, SectionContent),
    saveCounter: Schema.Int,
    savedAt: Schema.Int,
    copy: CopyInfo,
  },
  FailedReloadWorkingCopy: { failure: Failure },
  ClickedReapplyEdit: { sectionId: Schema.String },
  ClickedDiscardEdit: { sectionId: Schema.String },
  ClickedReplaceCopy: {},
  ConfirmedReplaceCopy: {},
  SucceededReplaceCopy: {},
  FailedReplaceCopy: { failure: Failure },
  CancelledConfirmation: {},
  CompletedFocusConfirmation: {},
  ClickedAddEntry: { target: Target },
  GeneratedEntryId: { target: Target, entryId: Schema.String },
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
  SucceededAddCoAuthor: { account: AccountRef },
  FailedAddCoAuthor: { failure: Failure },
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
  AddedImage: {},
  SucceededLoadImageUsage: { usage: ImageUsage },
  FailedLoadImageUsage: {},
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
    }
  })

export const LoadReport = Command.define('LoadReport', {
  args: { reportId: Schema.String },
  messages: [Message.SucceededLoadReport, Message.FailedLoadReport],
  execute: ({ reportId }) =>
    withQuoroom(client =>
      Effect.gen(function* () {
        const detail = yield* client.GetReport({ reportId })
        const version = yield* client.GetTemplateVersion({
          templateId: detail.summary.templateId,
          version: detail.summary.templateVersion,
          reportId,
        })
        const template = version.template
        yield* client.StartWorkingCopy({ reportId })
        const copy = yield* readWorkingCopy(
          client,
          reportId,
          Array.map(topLevelSections(template), section => section.id),
        )
        const people = yield* client.GetPeople({ reportId })
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
          people: people.people,
          saveCounter: copy.saveCounter,
          savedAt: copy.savedAt,
          copy: copy.copy,
          unitMembers,
        }
      }),
    ).pipe(
      Effect.map(loaded => Message.SucceededLoadReport({ loaded })),
      Effect.catch(error =>
        Effect.succeed(Message.FailedLoadReport({ failure: failureOf(error) })),
      ),
    ),
})

export const SaveSection = Command.define('SaveSection', {
  args: {
    reportId: Schema.String,
    sectionId: Schema.String,
    saveCounter: Schema.Int,
    content: SectionContent,
  },
  messages: [
    Message.SucceededSaveSection,
    Message.FailedSaveSection,
    Message.StaleSaveSection,
  ],
  execute: ({ reportId, sectionId, saveCounter, content }) =>
    withQuoroom(client =>
      client.SaveSection({ reportId, sectionId, saveCounter, content }),
    ).pipe(
      Effect.map(saved =>
        Message.SucceededSaveSection({
          sectionId,
          saveCounter: saved.saveCounter,
          savedAt: saved.savedAt,
        }),
      ),
      Effect.catch(error =>
        Effect.succeed(
          isStaleSave(error)
            ? Message.StaleSaveSection({ sectionId })
            : Message.FailedSaveSection({
                sectionId,
                failure: failureOf(error),
              }),
        ),
      ),
    ),
})

export const ReloadWorkingCopy = Command.define('ReloadWorkingCopy', {
  args: { reportId: Schema.String, sectionIds: Schema.Array(Schema.String) },
  messages: [
    Message.SucceededReloadWorkingCopy,
    Message.FailedReloadWorkingCopy,
  ],
  execute: ({ reportId, sectionIds }) =>
    withQuoroom(client => readWorkingCopy(client, reportId, sectionIds)).pipe(
      Effect.map(copy => Message.SucceededReloadWorkingCopy(copy)),
      Effect.catch(error =>
        Effect.succeed(
          Message.FailedReloadWorkingCopy({ failure: failureOf(error) }),
        ),
      ),
    ),
})

// NOTE: Throws the author's working copy away and starts again from the
// latest shared draft (`replace`). The screen asks first.
export const ReplaceWorkingCopy = Command.define('ReplaceWorkingCopy', {
  args: { reportId: Schema.String },
  messages: [Message.SucceededReplaceCopy, Message.FailedReplaceCopy],
  execute: ({ reportId }) =>
    withQuoroom(client =>
      client.StartWorkingCopy({ reportId, replace: true }),
    ).pipe(
      Effect.map(() => Message.SucceededReplaceCopy()),
      Effect.catch(error =>
        Effect.succeed(
          Message.FailedReplaceCopy({ failure: failureOf(error) }),
        ),
      ),
    ),
})

// NOTE: An entry's ID is random and chosen here, so two authors who each add
// an entry to the same draft never choose the same one.
export const NewEntryId = Command.define('NewEntryId', {
  args: { target: Target },
  messages: [Message.GeneratedEntryId],
  execute: ({ target }) =>
    Effect.flatMap(Crypto.Crypto, crypto => crypto.randomUUIDv4).pipe(
      Effect.provide(BrowserCrypto.layer),
      Effect.map(uuid =>
        Message.GeneratedEntryId({
          target,
          entryId: uuid.replaceAll('-', '').slice(0, 16),
        }),
      ),
      Effect.catch(() =>
        Effect.succeed(Message.GeneratedEntryId({ target, entryId: '' })),
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
  args: { reportId: Schema.String },
  messages: [Message.SucceededLoadImageUsage, Message.FailedLoadImageUsage],
  execute: ({ reportId }) =>
    withQuoroom(client => client.ListImages({ reportId })).pipe(
      Effect.map(list =>
        Message.SucceededLoadImageUsage({
          usage: {
            usedBytes: list.referencedBytes,
            limitBytes: list.limitBytes,
          },
        }),
      ),
      Effect.catch(() => Effect.succeed(Message.FailedLoadImageUsage())),
    ),
})

export const AddCoAuthor = Command.define('AddCoAuthor', {
  args: { reportId: Schema.String, accountId: Schema.String },
  messages: [Message.SucceededAddCoAuthor, Message.FailedAddCoAuthor],
  execute: ({ reportId, accountId }) =>
    withQuoroom(client => client.AddCoAuthor({ reportId, accountId })).pipe(
      Effect.map(added =>
        Message.SucceededAddCoAuthor({ account: added.account }),
      ),
      Effect.catch(error =>
        Effect.succeed(
          Message.FailedAddCoAuthor({ failure: failureOf(error) }),
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

export const enter = (
  origin: string,
  reportId: string,
): Update.Return<Model, Message> => ({
  model: modifyFields(initialModel, {
    origin: () => origin,
    reportId: () => reportId,
  }),
  commands: [LoadReport({ reportId })],
})

// UPDATE

export const hasUnsavedEdits = (model: Model): boolean =>
  !Array.isReadonlyArrayEmpty(model.dirtySectionIds) ||
  !SaveStatus.guards.Saved(model.save)

const EMPTY_SECTION: SectionContent = { values: {}, sections: {} }

// NOTE: One save at a time, in the order the sections were edited. Nothing is
// sent while a save is in flight, while the working copy is known to be stale
// (the edit is kept and the author is asked to reload), or while the browser
// is offline.
const startSave = (model: Model): Update.Return<Model, Message> => {
  if (
    SaveStatus.guards.Saving(model.save) ||
    SaveStatus.guards.Stale(model.save) ||
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
        reportId: model.reportId,
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
// from the Model: raising the base above every version they have reported
// makes them do so.
const bumpEditorBase = (model: Model): Model =>
  modifyFields(model, {
    editorBase: base =>
      Math.max(base, ...Record.values(model.editorVersions)) + 1,
  })

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

export const update = (model: Model, message: Message) =>
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
          }),
        }),
        requestEditor,
      ]),
    FailedLoadReport: ({ failure }) => ({
      model: modifyFields(model, { load: () => LoadState.Failed({ failure }) }),
    }),
    ClickedRetryLoad: () => ({
      model: modifyFields(model, { load: () => LoadState.Loading() }),
      commands: [LoadReport({ reportId: model.reportId })],
    }),
    SelectedSection: ({ key }) =>
      Update.combine(model, [selectSection(key), requestEditor]),
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
                Record.set(
                  versions,
                  richKey(sectionKey, steps, itemId),
                  version,
                ),
              maybeRefusal: () => Option.none(),
            }),
            sectionKey,
            steps,
            itemId,
            serializeRichText(doc) === EMPTY_RICH_TEXT_JSON
              ? Option.none()
              : Option.some({ type: 'rich_text', doc }),
          ),
      }),
    AddedImage: () => ({
      model,
      commands: [LoadImageUsage({ reportId: model.reportId })],
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
    StaleSaveSection: ({ sectionId }) => ({
      model: modifyFields(withDirty(model, sectionId), {
        save: () => SaveStatus.Stale({ sectionId }),
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
        : withTemplate(model, template => ({
            model: modifyFields(model, {
              isReloading: () => true,
              maybeEditNote: () => Option.none(),
            }),
            commands: [
              ReloadWorkingCopy({
                reportId: model.reportId,
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
        model: bumpEditorBase(
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
      }
    },
    FailedReloadWorkingCopy: ({ failure }) => ({
      model: modifyFields(setNote(model, failureText(failure)), {
        isReloading: () => false,
      }),
    }),
    ClickedReapplyEdit: ({ sectionId }) =>
      Option.match(
        Array.findFirst(model.keptEdits, edit => edit.sectionId === sectionId),
        {
          onNone: () => ({ model }),
          onSome: edit =>
            Update.combine(model, [
              stepModel =>
                startSave(
                  withDirty(
                    bumpEditorBase(
                      modifyFields(stepModel, {
                        contents: contents =>
                          setSectionContent(contents, sectionId, edit.content),
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
            ]),
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
      Option.exists(model.maybeConfirmation, Confirmation.guards.ReplaceCopy)
        ? {
            model: modifyFields(model, {
              maybeConfirmation: () => Option.none(),
              isReloading: () => true,
            }),
            commands: [ReplaceWorkingCopy({ reportId: model.reportId })],
          }
        : { model },
    SucceededReplaceCopy: () => ({
      model: modifyFields(model, {
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
        editorBase: () => 0,
        maybeSelectedKey: () => Option.none(),
        maybeEditNote: () => Option.none(),
      }),
      commands: [LoadReport({ reportId: model.reportId })],
    }),
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
            commands: [NewEntryId({ target })],
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
            reportId: model.reportId,
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
  })

// SUBSCRIPTION

export const SAVE_RETRY_SECONDS = 5

export const subscriptions = Subscription.make<Model, Message>()(entry => ({
  // NOTE: Leaving the page with edits that are not saved asks first.
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
                        [
                          h.Class(
                            'flex flex-col gap-2 py-2',
                          ),
                        ],
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

const timeText = (epochMs: number): string =>
  new Intl.DateTimeFormat('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(epochMs))

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
      Math.max(
        model.editorBase,
        model.editorVersions[richKey(sectionKey, steps, itemId)] ?? 0,
      ),
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
            ...Option.match(
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
            ),
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
      endedBanner(outline.end, h),
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
      workingCopyPanel(model, h),
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
