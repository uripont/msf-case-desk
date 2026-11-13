import { clsx } from 'clsx'
import { Array, Effect, Option, Schema } from 'effect'
import { Command, Dom, Submodel, Update } from 'foldkit'
import { Html, HtmlBuilder } from 'foldkit/html'
import { defineMessageUnion } from 'foldkit/message'
import { defineTaggedUnion } from 'foldkit/schema'
import { modifyFields } from 'foldkit/struct'

import {
  AccountRef,
  type EndState,
  ItemValue,
  type NumberedSection,
  PeopleList,
  type Permission,
  ReportDetail,
  type ReportState,
  Section,
  SectionContent,
  type SectionState,
  Template,
  UnitMember,
  contentOfKey,
  endState,
  isEntryKey,
  numberSections,
  sectionOfKey,
  sectionStates,
  topSectionIdOfKey,
  withItemValue,
} from '@case-desk/domain'

import { AppRoute, pathOf } from '../route'
import { focusRing } from '../style'
import { withQuoroom } from './api'
import { Failure, failureOf } from './failure'
import { type CaseValues, itemField } from './fields'
import { FormState, formStatus, isSubmitting } from './formState'
import {
  failureAlert,
  loadingText,
  panel,
  selectField,
  smallButton,
  statusText,
  submitButton,
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
// Rich text and repeated entries are placeholders until stages 4c and 4e.

export const SECTION_HEADING_ID = 'section-heading'

// MODEL

export const SaveStatus = defineTaggedUnion({
  Saved: {},
  Saving: { sectionId: Schema.String },
  Failed: { failure: Failure },
})
export type SaveStatus = typeof SaveStatus.Type

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
})

export const LoadedReport = Schema.Struct({
  detail: ReportDetail,
  template: Template,
  unitName: Schema.String,
  contents: Schema.Record(Schema.String, SectionContent),
  people: PeopleList,
  saveCounter: Schema.Int,
  unitMembers: Schema.Array(UnitMember),
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
    itemId: Schema.String,
    maybeValue: Schema.Option(ItemValue),
  },
  SucceededSaveSection: {
    sectionId: Schema.String,
    saveCounter: Schema.Int,
  },
  FailedSaveSection: { sectionId: Schema.String, failure: Failure },
  ClickedRetrySave: {},
  SelectedCoAuthor: { value: Schema.String },
  SubmittedCoAuthor: {},
  SucceededAddCoAuthor: { account: AccountRef },
  FailedAddCoAuthor: { failure: Failure },
  CompletedFocusSectionHeading: {},
})
export type Message = typeof Message.Type

// COMMAND

const topLevelSections = (template: Template): ReadonlyArray<Section> =>
  template.conclusion === undefined
    ? template.sections
    : [...template.sections, template.conclusion]

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
        const outline = yield* client.StartWorkingCopy({ reportId })
        const sections = yield* Effect.forEach(
          topLevelSections(template),
          section =>
            client.GetWorkingCopySection({ reportId, sectionId: section.id }),
          { concurrency: 4 },
        )
        const people = yield* client.GetPeople({ reportId })
        const units = yield* client.ListUnits()
        const unitMembers = yield* client
          .ListUnitMembers({ unit: detail.summary.caseFile.unit })
          .pipe(Effect.catch(() => Effect.succeed([])))
        return {
          detail,
          template,
          unitName:
            units.find(unit => unit.id === detail.summary.caseFile.unit)
              ?.name ?? '',
          contents: Object.fromEntries(
            sections
              .filter(
                section =>
                  Object.keys(section.content.values).length > 0 ||
                  Object.keys(section.content.sections).length > 0 ||
                  section.content.notApplicable !== undefined ||
                  section.content.entries !== undefined,
              )
              .map(section => [section.sectionId, section.content]),
          ),
          people: people.people,
          saveCounter: outline.saveCounter,
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
  messages: [Message.SucceededSaveSection, Message.FailedSaveSection],
  execute: ({ reportId, sectionId, saveCounter, content }) =>
    withQuoroom(client =>
      client.SaveSection({ reportId, sectionId, saveCounter, content }),
    ).pipe(
      Effect.map(saved =>
        Message.SucceededSaveSection({
          sectionId,
          saveCounter: saved.saveCounter,
        }),
      ),
      Effect.catch(error =>
        Effect.succeed(
          Message.FailedSaveSection({ sectionId, failure: failureOf(error) }),
        ),
      ),
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

export const outlineOf = (template: Template, model: Model): Outline => ({
  rows: numberSections(template, { sections: model.contents }),
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

const startSave = (model: Model): Update.Return<Model, Message> => {
  if (SaveStatus.guards.Saving(model.save)) {
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
        content: model.contents[next] ?? { values: {}, sections: {} },
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

export const update = (model: Model, message: Message) =>
  Message.match<Update.Return<Model, Message>>(message, {
    SucceededLoadReport: ({ loaded }) => ({
      model: modifyFields(model, {
        load: () => LoadState.Loaded(),
        maybeDetail: () => Option.some(loaded.detail),
        maybeTemplate: () => Option.some(loaded.template),
        unitName: () => loaded.unitName,
        contents: () => loaded.contents,
        people: () => loaded.people,
        saveCounter: () => loaded.saveCounter,
        unitMembers: () => loaded.unitMembers,
      }),
    }),
    FailedLoadReport: ({ failure }) => ({
      model: modifyFields(model, { load: () => LoadState.Failed({ failure }) }),
    }),
    ClickedRetryLoad: () => ({
      model: modifyFields(model, { load: () => LoadState.Loading() }),
      commands: [LoadReport({ reportId: model.reportId })],
    }),
    SelectedSection: ({ key }) => ({
      model: modifyFields(model, {
        maybeSelectedKey: () => Option.some(key),
        isNavigatorOpen: () => false,
      }),
      commands: [FocusSectionHeading()],
    }),
    ToggledNavigator: () => ({
      model: modifyFields(model, { isNavigatorOpen: open => !open }),
    }),
    ChangedItem: ({ sectionKey, itemId, maybeValue }) =>
      isEntryKey(sectionKey)
        ? { model }
        : startSave(
            withDirty(
              modifyFields(model, {
                contents: contents =>
                  withItemValue(
                    contents,
                    sectionKey,
                    itemId,
                    Option.getOrUndefined(maybeValue),
                  ),
              }),
              topSectionIdOfKey(sectionKey),
            ),
          ),
    SucceededSaveSection: ({ saveCounter }) =>
      startSave(
        modifyFields(model, {
          saveCounter: () => saveCounter,
          save: () => SaveStatus.Saved(),
        }),
      ),
    FailedSaveSection: ({ sectionId, failure }) => ({
      model: modifyFields(withDirty(model, sectionId), {
        save: () => SaveStatus.Failed({ failure }),
      }),
    }),
    ClickedRetrySave: () =>
      startSave(
        modifyFields(model, {
          save: () => SaveStatus.Saved(),
        }),
      ),
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

// VIEW

const INDENT = ['pl-3', 'pl-7', 'pl-11', 'pl-14'] as const

const rowLabel = (row: NumberedSection): string =>
  row.number === undefined ? row.title : `${row.number.full} ${row.title}`

const navigatorRow = (
  row: NumberedSection,
  state: SectionState,
  isSelected: boolean,
  h: HtmlBuilder<Message>,
): Html =>
  h.keyed('li')(
    row.key,
    [],
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

const subsectionList = (
  section: Section,
  rows: ReadonlyArray<NumberedSection>,
  outline: Outline,
  selectedKey: string,
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
            [h.Class('flex flex-col border-y border-msf-line')],
            Array.map(children, child =>
              Option.match(
                Array.findFirst(
                  rows,
                  row =>
                    row.sectionId === child.id &&
                    row.parentKey === selectedKey &&
                    row.entryId === undefined,
                ),
                {
                  onNone: () =>
                    h.keyed('li')(
                      child.id,
                      [h.Class('py-3 text-base text-msf-grey')],
                      [`${child.title}: entries are added in a later step.`],
                    ),
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
  const values = contentOfKey(model.contents, row.key).values
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
            access.kind === 'read_only'
              ? h.p([h.Class('text-base text-msf-grey')], [access.reason])
              : h.empty,
            section.repeat === undefined
              ? h.empty
              : h.p(
                  [h.Class('text-base text-msf-grey')],
                  [
                    'Entries of this repeatable section are added in a later step.',
                  ],
                ),
            ...Array.map(section.items, item =>
              itemField(
                h,
                {
                  caseValues: caseValuesOf(model, detail),
                  people: model.people,
                  isDisabled: access.kind === 'read_only',
                  onChange: (itemId, maybeValue) =>
                    Message.ChangedItem({
                      sectionKey: row.key,
                      itemId,
                      maybeValue,
                    }),
                },
                item,
                values[item.id],
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
                    ['Entries of this section are edited in a later step.'],
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
                  subsectionList(
                    section,
                    outline.rows,
                    outline,
                    selectedKey,
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

const saveIndicator = (model: Model, h: HtmlBuilder<Message>): Html =>
  SaveStatus.match(model.save, {
    Saved: () =>
      Array.isReadonlyArrayEmpty(model.dirtySectionIds)
        ? statusText(h, 'All changes saved.')
        : statusText(h, 'Saving.'),
    Saving: () => statusText(h, 'Saving.'),
    Failed: ({ failure }) =>
      h.div(
        [h.Class('flex flex-wrap items-baseline gap-3')],
        [
          failureAlert(h, failure),
          smallButton(h, 'Try saving again', Message.ClickedRetrySave()),
        ],
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
        ],
      ),
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
