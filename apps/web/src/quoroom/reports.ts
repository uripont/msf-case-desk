import { Array, Effect, Option, Schema } from 'effect'
import { Command, Submodel, Update } from 'foldkit'
import { HtmlBuilder } from 'foldkit/html'
import { defineMessageUnion } from 'foldkit/message'
import { modifyFields } from 'foldkit/struct'

import {
  CaseFileRecord,
  PublishedTemplate,
  REPORT_STATES,
  ReportStateSchema,
  ReportSummary,
  Unit,
} from '@case-desk/domain'

import { AppRoute, pathOf } from '../route'
import { withQuoroom } from './api'
import { Failure, failureOf, failureText } from './failure'
import { FormState, formStatus, isSubmitting } from './formState'
import { reportStateText } from './report'
import {
  failureAlert,
  loadingText,
  pageShell,
  panel,
  selectField,
  smallButton,
  statusText,
  submitButton,
  textField,
} from './ui'
import { LoadState } from './unit'

// NOTE: The authors' reports: their reports in a unit by state and
// case file, with paging; the unit's case files, which authors of a report on
// one can retitle; and a new report from a published template version, which
// starts at Draft 0, the empty template, and makes its creator its first
// author. A case file is made together with its first report (D15): the
// reference is named by the template (`caseReferenceLabel`). Co-authors are
// added on the report itself.

export const PAGE_SIZE = 10
export const NEW_CASE_FILE = 'new'

type PublishedTemplateRecord = typeof PublishedTemplate.Type

// MODEL

export const CreatedReport = Schema.Struct({
  reportId: Schema.String,
  reference: Schema.String,
})
export type CreatedReport = typeof CreatedReport.Type

export const Renaming = Schema.Struct({
  caseFileId: Schema.String,
  title: Schema.String,
})
export type Renaming = typeof Renaming.Type

export const Model = Schema.Struct({
  load: LoadState,
  units: Schema.Array(Unit),
  selectedUnit: Schema.String,
  dataLoad: LoadState,
  reports: Schema.Array(ReportSummary),
  caseFiles: Schema.Array(CaseFileRecord),
  templates: Schema.Array(PublishedTemplate),
  maybeStateFilter: Schema.Option(ReportStateSchema),
  caseFileFilter: Schema.String,
  page: Schema.Int,
  caseFileChoice: Schema.String,
  newReference: Schema.String,
  newTitle: Schema.String,
  templateChoice: Schema.String,
  createForm: FormState,
  maybeCreated: Schema.Option(CreatedReport),
  maybeRenaming: Schema.Option(Renaming),
  renameForm: FormState,
})
export type Model = typeof Model.Type

export const initialModel = Model.make({
  load: LoadState.Loading(),
  units: [],
  selectedUnit: '',
  dataLoad: LoadState.Loading(),
  reports: [],
  caseFiles: [],
  templates: [],
  maybeStateFilter: Option.none(),
  caseFileFilter: '',
  page: 0,
  caseFileChoice: NEW_CASE_FILE,
  newReference: '',
  newTitle: '',
  templateChoice: '',
  createForm: FormState.Editing(),
  maybeCreated: Option.none(),
  maybeRenaming: Option.none(),
  renameForm: FormState.Editing(),
})

// MESSAGE

export const Message = defineMessageUnion({
  SucceededLoadUnits: { units: Schema.Array(Unit) },
  FailedLoadUnits: { failure: Failure },
  ClickedRetryLoad: {},
  SelectedUnit: { value: Schema.String },
  SucceededLoadReports: {
    unit: Schema.String,
    maybeState: Schema.Option(ReportStateSchema),
    reports: Schema.Array(ReportSummary),
    caseFiles: Schema.Array(CaseFileRecord),
    templates: Schema.Array(PublishedTemplate),
  },
  FailedLoadReports: { unit: Schema.String, failure: Failure },
  SelectedStateFilter: { value: Schema.String },
  SelectedCaseFileFilter: { value: Schema.String },
  ClickedPreviousPage: {},
  ClickedNextPage: {},
  SelectedCaseFileChoice: { value: Schema.String },
  UpdatedNewReference: { value: Schema.String },
  UpdatedNewTitle: { value: Schema.String },
  SelectedTemplate: { value: Schema.String },
  SubmittedReport: {},
  SucceededCreateReport: { report: ReportSummary },
  FailedCreateReport: { failure: Failure },
  ClickedRename: { caseFileId: Schema.String },
  UpdatedRenameTitle: { value: Schema.String },
  SubmittedRename: {},
  ClickedCancelRename: {},
  SucceededUpdateCaseFile: { caseFile: CaseFileRecord },
  FailedUpdateCaseFile: { failure: Failure },
})
export type Message = typeof Message.Type

// COMMAND

export const LoadUnits = Command.define('LoadUnits', {
  messages: [Message.SucceededLoadUnits, Message.FailedLoadUnits],
  execute: withQuoroom(client => client.ListUnits()).pipe(
    Effect.map(units => Message.SucceededLoadUnits({ units })),
    Effect.catch(error =>
      Effect.succeed(Message.FailedLoadUnits({ failure: failureOf(error) })),
    ),
  ),
})

export const LoadReports = Command.define('LoadReports', {
  args: {
    unit: Schema.String,
    maybeState: Schema.Option(ReportStateSchema),
  },
  messages: [Message.SucceededLoadReports, Message.FailedLoadReports],
  execute: ({ unit, maybeState }) =>
    withQuoroom(client =>
      Effect.all({
        reports: client.ListReports({
          unit,
          ...Option.match(maybeState, {
            onNone: () => ({}),
            onSome: state => ({ state }),
          }),
        }),
        caseFiles: client.ListCaseFiles({ unit }),
        templates: client.ListPublishedTemplates(),
      }),
    ).pipe(
      Effect.map(({ reports, caseFiles, templates }) =>
        Message.SucceededLoadReports({
          unit,
          maybeState,
          reports,
          caseFiles,
          templates,
        }),
      ),
      Effect.catch(error =>
        Effect.succeed(
          Message.FailedLoadReports({ unit, failure: failureOf(error) }),
        ),
      ),
    ),
})

export const CreateReport = Command.define('CreateReport', {
  args: {
    unit: Schema.String,
    existingCaseFile: Schema.Option(Schema.String),
    reference: Schema.String,
    title: Schema.String,
    templateId: Schema.String,
    templateVersion: Schema.Int,
  },
  messages: [Message.SucceededCreateReport, Message.FailedCreateReport],
  execute: ({
    unit,
    existingCaseFile,
    reference,
    title,
    templateId,
    templateVersion,
  }) =>
    withQuoroom(client =>
      client.CreateReport({
        unit,
        caseFile: Option.match(existingCaseFile, {
          onNone: () => ({ reference, title }),
          onSome: existing => ({ existing }),
        }),
        templateId,
        templateVersion,
      }),
    ).pipe(
      Effect.map(report => Message.SucceededCreateReport({ report })),
      Effect.catch(error =>
        Effect.succeed(
          Message.FailedCreateReport({ failure: failureOf(error) }),
        ),
      ),
    ),
})

export const UpdateCaseFile = Command.define('UpdateCaseFile', {
  args: { caseFileId: Schema.String, title: Schema.String },
  messages: [Message.SucceededUpdateCaseFile, Message.FailedUpdateCaseFile],
  execute: ({ caseFileId, title }) =>
    withQuoroom(client => client.UpdateCaseFile({ caseFileId, title })).pipe(
      Effect.map(caseFile => Message.SucceededUpdateCaseFile({ caseFile })),
      Effect.catch(error =>
        Effect.succeed(
          Message.FailedUpdateCaseFile({ failure: failureOf(error) }),
        ),
      ),
    ),
})

// QUERIES

export const templateKey = (template: PublishedTemplateRecord): string =>
  `${template.id}@${template.version}`

export const stateFilterOf = (
  value: string,
): Option.Option<typeof ReportStateSchema.Type> =>
  Schema.decodeUnknownOption(ReportStateSchema)(value)

export const visibleReportsOf = (model: Model): ReadonlyArray<ReportSummary> =>
  model.caseFileFilter === ''
    ? model.reports
    : Array.filter(
        model.reports,
        report => report.caseFile.id === model.caseFileFilter,
      )

export const pageCountOf = (count: number): number =>
  Math.max(1, Math.ceil(count / PAGE_SIZE))

export const clampedPageOf = (model: Model): number =>
  Math.min(model.page, pageCountOf(visibleReportsOf(model).length) - 1)

export const pageOf = (model: Model): ReadonlyArray<ReportSummary> =>
  Array.take(
    Array.drop(visibleReportsOf(model), clampedPageOf(model) * PAGE_SIZE),
    PAGE_SIZE,
  )

export const chosenTemplateOf = (
  model: Model,
): Option.Option<PublishedTemplateRecord> =>
  Array.findFirst(
    model.templates,
    template => templateKey(template) === model.templateChoice,
  )

export const referenceLabelOf = (model: Model): string =>
  Option.match(chosenTemplateOf(model), {
    onNone: () => 'Case reference',
    onSome: template => template.caseReferenceLabel,
  })

// INIT

export const enter = (model: Model): Update.Return<Model, Message> => ({
  model: modifyFields(model, {
    load: () => LoadState.Loading(),
    maybeCreated: () => Option.none(),
    maybeRenaming: () => Option.none(),
  }),
  commands: [LoadUnits()],
})

// UPDATE

const reload = (model: Model): Update.Return<Model, Message> => ({
  model,
  commands: [
    LoadReports({
      unit: model.selectedUnit,
      maybeState: model.maybeStateFilter,
    }),
  ],
})

const replaceCaseFile = (
  caseFiles: ReadonlyArray<CaseFileRecord>,
  caseFile: CaseFileRecord,
): ReadonlyArray<CaseFileRecord> =>
  Array.map(caseFiles, existing =>
    existing.id === caseFile.id ? caseFile : existing,
  )

const invalidCreate = (
  model: Model,
  message: string,
): Update.Return<Model, Message> => ({
  model: modifyFields(model, {
    createForm: () => FormState.Invalid({ message }),
  }),
})

const submitReport = (model: Model): Update.Return<Model, Message> => {
  if (isSubmitting(model.createForm)) {
    return { model }
  }
  const reference = model.newReference.trim()
  const title = model.newTitle.trim()
  const isNew = model.caseFileChoice === NEW_CASE_FILE
  return Option.match(chosenTemplateOf(model), {
    onNone: () =>
      invalidCreate(
        model,
        'No template is published yet. A template editor publishes one.',
      ),
    onSome: template => {
      if (isNew && reference === '') {
        return invalidCreate(
          model,
          `Write the ${template.caseReferenceLabel.toLowerCase()}.`,
        )
      }
      if (isNew && title === '') {
        return invalidCreate(model, 'Give the case file a title.')
      }
      return {
        model: modifyFields(model, {
          createForm: () => FormState.Submitting(),
          maybeCreated: () => Option.none(),
        }),
        commands: [
          CreateReport({
            unit: model.selectedUnit,
            existingCaseFile: isNew
              ? Option.none()
              : Option.some(model.caseFileChoice),
            reference,
            title,
            templateId: template.id,
            templateVersion: template.version,
          }),
        ],
      }
    },
  })
}

const submitRename = (model: Model): Update.Return<Model, Message> => {
  if (isSubmitting(model.renameForm)) {
    return { model }
  }
  return Option.match(model.maybeRenaming, {
    onNone: () => ({ model }),
    onSome: renaming => {
      const title = renaming.title.trim()
      return title === ''
        ? {
            model: modifyFields(model, {
              renameForm: () =>
                FormState.Invalid({ message: 'Give the case file a title.' }),
            }),
          }
        : {
            model: modifyFields(model, {
              renameForm: () => FormState.Submitting(),
            }),
            commands: [
              UpdateCaseFile({ caseFileId: renaming.caseFileId, title }),
            ],
          }
    },
  })
}

export const update = (model: Model, message: Message) =>
  Message.match<Update.Return<Model, Message>>(message, {
    SucceededLoadUnits: ({ units }) => {
      const selectedUnit = Array.some(
        units,
        unit => unit.id === model.selectedUnit,
      )
        ? model.selectedUnit
        : (units[0]?.id ?? '')
      const loaded = modifyFields(model, {
        load: () => LoadState.Loaded(),
        units: () => units,
        selectedUnit: () => selectedUnit,
        dataLoad: () => LoadState.Loading(),
      })
      return selectedUnit === '' ? { model: loaded } : reload(loaded)
    },
    FailedLoadUnits: ({ failure }) => ({
      model: modifyFields(model, { load: () => LoadState.Failed({ failure }) }),
    }),
    ClickedRetryLoad: () => enter(model),
    SelectedUnit: ({ value }) =>
      reload(
        modifyFields(model, {
          selectedUnit: () => value,
          dataLoad: () => LoadState.Loading(),
          reports: () => [],
          caseFiles: () => [],
          caseFileFilter: () => '',
          caseFileChoice: () => NEW_CASE_FILE,
          page: () => 0,
          maybeCreated: () => Option.none(),
          maybeRenaming: () => Option.none(),
        }),
      ),
    SucceededLoadReports: ({
      unit,
      maybeState,
      reports,
      caseFiles,
      templates,
    }) =>
      unit !== model.selectedUnit ||
      Option.getOrElse(maybeState, () => '') !==
        Option.getOrElse(model.maybeStateFilter, () => '')
        ? { model }
        : {
            model: modifyFields(model, {
              dataLoad: () => LoadState.Loaded(),
              reports: () => reports,
              caseFiles: () => caseFiles,
              templates: () => templates,
              templateChoice: choice =>
                Array.some(
                  templates,
                  template => templateKey(template) === choice,
                )
                  ? choice
                  : Option.match(Array.head(templates), {
                      onNone: () => '',
                      onSome: templateKey,
                    }),
              caseFileChoice: choice =>
                choice === NEW_CASE_FILE ||
                Array.some(caseFiles, caseFile => caseFile.id === choice)
                  ? choice
                  : NEW_CASE_FILE,
              caseFileFilter: filter =>
                Array.some(caseFiles, caseFile => caseFile.id === filter)
                  ? filter
                  : '',
            }),
          },
    FailedLoadReports: ({ unit, failure }) =>
      unit !== model.selectedUnit
        ? { model }
        : {
            model: modifyFields(model, {
              dataLoad: () => LoadState.Failed({ failure }),
            }),
          },
    SelectedStateFilter: ({ value }) =>
      reload(
        modifyFields(model, {
          maybeStateFilter: () => stateFilterOf(value),
          page: () => 0,
        }),
      ),
    SelectedCaseFileFilter: ({ value }) => ({
      model: modifyFields(model, {
        caseFileFilter: () => value,
        page: () => 0,
      }),
    }),
    ClickedPreviousPage: () => ({
      model: modifyFields(model, {
        page: () => Math.max(0, clampedPageOf(model) - 1),
      }),
    }),
    ClickedNextPage: () => ({
      model: modifyFields(model, {
        page: () =>
          Math.min(
            clampedPageOf(model) + 1,
            pageCountOf(visibleReportsOf(model).length) - 1,
          ),
      }),
    }),
    SelectedCaseFileChoice: ({ value }) => ({
      model: modifyFields(model, {
        caseFileChoice: () => value,
        createForm: () => FormState.Editing(),
      }),
    }),
    UpdatedNewReference: ({ value }) => ({
      model: modifyFields(model, {
        newReference: () => value,
        createForm: () => FormState.Editing(),
      }),
    }),
    UpdatedNewTitle: ({ value }) => ({
      model: modifyFields(model, {
        newTitle: () => value,
        createForm: () => FormState.Editing(),
      }),
    }),
    SelectedTemplate: ({ value }) => ({
      model: modifyFields(model, {
        templateChoice: () => value,
        createForm: () => FormState.Editing(),
      }),
    }),
    SubmittedReport: () => submitReport(model),
    SucceededCreateReport: ({ report }) =>
      reload(
        modifyFields(model, {
          newReference: () => '',
          newTitle: () => '',
          caseFileChoice: () => NEW_CASE_FILE,
          createForm: () => FormState.Editing(),
          maybeCreated: () =>
            Option.some({
              reportId: report.id,
              reference: report.caseFile.reference,
            }),
          page: () => 0,
        }),
      ),
    FailedCreateReport: ({ failure }) => ({
      model: modifyFields(model, {
        createForm: () => FormState.Failed({ failure }),
      }),
    }),
    ClickedRename: ({ caseFileId }) => ({
      model: modifyFields(model, {
        maybeRenaming: () =>
          Option.map(
            Array.findFirst(
              model.caseFiles,
              caseFile => caseFile.id === caseFileId,
            ),
            caseFile => ({ caseFileId, title: caseFile.title }),
          ),
        renameForm: () => FormState.Editing(),
      }),
    }),
    UpdatedRenameTitle: ({ value }) => ({
      model: modifyFields(model, {
        maybeRenaming: maybeRenaming =>
          Option.map(maybeRenaming, renaming => ({
            ...renaming,
            title: value,
          })),
        renameForm: () => FormState.Editing(),
      }),
    }),
    SubmittedRename: () => submitRename(model),
    ClickedCancelRename: () => ({
      model: modifyFields(model, {
        maybeRenaming: () => Option.none(),
        renameForm: () => FormState.Editing(),
      }),
    }),
    SucceededUpdateCaseFile: ({ caseFile }) => ({
      model: modifyFields(model, {
        caseFiles: caseFiles => replaceCaseFile(caseFiles, caseFile),
        reports: reports =>
          Array.map(reports, report =>
            report.caseFile.id === caseFile.id
              ? { ...report, caseFile }
              : report,
          ),
        maybeRenaming: () => Option.none(),
        renameForm: () => FormState.Editing(),
      }),
    }),
    FailedUpdateCaseFile: ({ failure }) => ({
      model: modifyFields(model, {
        renameForm: () => FormState.Failed({ failure }),
      }),
    }),
  })

// VIEW

const reportRow = (report: ReportSummary, h: HtmlBuilder<Message>) =>
  h.keyed('li')(
    report.id,
    [h.Class('flex flex-col gap-1 py-4')],
    [
      h.a(
        [
          h.Href(pathOf(AppRoute.Report({ reportId: report.id }))),
          h.Class(
            'text-lg font-medium text-msf-black underline decoration-msf-line underline-offset-4 hover:decoration-msf-red',
          ),
        ],
        [`${report.caseFile.reference}: ${report.caseFile.title}`],
      ),
      h.span(
        [h.Class('text-base text-msf-grey')],
        [
          `${report.templateName} · ${reportStateText(report.state)} · Draft ${report.latestDraft}`,
        ],
      ),
    ],
  )

const stateChoices = [
  { value: '', label: 'All states' },
  ...Array.map(REPORT_STATES, state => ({
    value: state,
    label: reportStateText(state),
  })),
]

const pagination = (model: Model, h: HtmlBuilder<Message>) => {
  const pages = pageCountOf(visibleReportsOf(model).length)
  const current = clampedPageOf(model)
  return pages === 1
    ? h.empty
    : h.div(
        [h.Class('flex flex-wrap items-center gap-4')],
        [
          current === 0
            ? h.empty
            : smallButton(h, 'Previous page', Message.ClickedPreviousPage()),
          h.span(
            [h.Role('status'), h.Class('text-base text-msf-grey')],
            [`Page ${current + 1} of ${pages}`],
          ),
          current === pages - 1
            ? h.empty
            : smallButton(h, 'Next page', Message.ClickedNextPage()),
        ],
      )
}

const reportsPanel = (model: Model, h: HtmlBuilder<Message>) =>
  panel(
    h,
    'Your reports',
    [
      h.div(
        [h.Class('grid gap-4 sm:grid-cols-2')],
        [
          selectField(
            h,
            'reports-state',
            'State',
            Option.getOrElse(model.maybeStateFilter, () => ''),
            stateChoices,
            value => Message.SelectedStateFilter({ value }),
          ),
          selectField(
            h,
            'reports-case-file',
            'Case file',
            model.caseFileFilter,
            [
              { value: '', label: 'All case files' },
              ...Array.map(model.caseFiles, caseFile => ({
                value: caseFile.id,
                label: `${caseFile.reference}: ${caseFile.title}`,
              })),
            ],
            value => Message.SelectedCaseFileFilter({ value }),
          ),
        ],
      ),
      Array.match(pageOf(model), {
        onEmpty: () =>
          h.p(
            [h.Class('text-lg text-msf-grey')],
            [
              Array.isReadonlyArrayEmpty(model.reports)
                ? 'No reports yet. Start one below.'
                : 'No report matches these filters.',
            ],
          ),
        onNonEmpty: rows =>
          h.ul(
            [
              h.AriaLabel('Your reports'),
              h.Class(
                'flex flex-col divide-y divide-msf-line border-y border-msf-line',
              ),
            ],
            Array.map(rows, report => reportRow(report, h)),
          ),
      }),
      pagination(model, h),
    ],
    Option.some(
      'Reports where you are an author, in this unit. A new report starts at Draft 0, the empty template.',
    ),
  )

const createdNotice = (model: Model, h: HtmlBuilder<Message>) =>
  Option.match(model.maybeCreated, {
    onNone: () => h.empty,
    onSome: created =>
      h.div(
        [h.Class('flex flex-col gap-2')],
        [
          statusText(h, `Report for ${created.reference} created at Draft 0.`),
          h.a(
            [
              h.Href(pathOf(AppRoute.Report({ reportId: created.reportId }))),
              h.Class('self-start text-lg font-medium underline'),
            ],
            [`Open report ${created.reference}`],
          ),
        ],
      ),
  })

const createPanel = (model: Model, h: HtmlBuilder<Message>) =>
  panel(
    h,
    'Start a report',
    [
      createdNotice(model, h),
      Array.match(model.templates, {
        onEmpty: () =>
          h.p(
            [h.Class('text-lg text-msf-grey')],
            ['No template is published yet. A template editor publishes one.'],
          ),
        onNonEmpty: templates =>
          h.form(
            [
              h.Class('flex max-w-md flex-col gap-4'),
              h.AriaLabel('Start a report'),
              h.OnSubmit(Message.SubmittedReport()),
            ],
            [
              selectField(
                h,
                'new-report-template',
                'Template',
                model.templateChoice,
                Array.map(templates, template => ({
                  value: templateKey(template),
                  label: `${template.name} (version ${template.version})`,
                })),
                value => Message.SelectedTemplate({ value }),
              ),
              selectField(
                h,
                'new-report-case-file',
                'Case file',
                model.caseFileChoice,
                [
                  { value: NEW_CASE_FILE, label: 'A new case file' },
                  ...Array.map(model.caseFiles, caseFile => ({
                    value: caseFile.id,
                    label: `${caseFile.reference}: ${caseFile.title}`,
                  })),
                ],
                value => Message.SelectedCaseFileChoice({ value }),
              ),
              model.caseFileChoice === NEW_CASE_FILE
                ? textField(h, {
                    id: 'new-report-reference',
                    label: referenceLabelOf(model),
                    value: model.newReference,
                    onInput: value => Message.UpdatedNewReference({ value }),
                  })
                : h.empty,
              model.caseFileChoice === NEW_CASE_FILE
                ? textField(h, {
                    id: 'new-report-title',
                    label: 'Case file title',
                    value: model.newTitle,
                    onInput: value => Message.UpdatedNewTitle({ value }),
                  })
                : h.empty,
              formStatus(h, model.createForm, 'Creating the report.'),
              submitButton(
                h,
                'Create report',
                isSubmitting(model.createForm),
                'Creating…',
              ),
            ],
          ),
      }),
    ],
    Option.some(
      'You become the first author of the report and can add co-authors on it. The template version is fixed for the life of the report.',
    ),
  )

const renameForm = (
  renaming: Renaming,
  model: Model,
  h: HtmlBuilder<Message>,
) =>
  h.form(
    [
      h.Class('flex max-w-md flex-col gap-3'),
      h.AriaLabel('Rename the case file'),
      h.OnSubmit(Message.SubmittedRename()),
    ],
    [
      textField(h, {
        id: 'rename-title',
        label: 'New title',
        value: renaming.title,
        onInput: value => Message.UpdatedRenameTitle({ value }),
      }),
      formStatus(h, model.renameForm, 'Saving the title.'),
      h.div(
        [h.Class('flex flex-wrap gap-3')],
        [
          submitButton(
            h,
            'Save title',
            isSubmitting(model.renameForm),
            'Saving…',
          ),
          smallButton(h, 'Cancel', Message.ClickedCancelRename()),
        ],
      ),
    ],
  )

const caseFileRow = (
  caseFile: CaseFileRecord,
  model: Model,
  h: HtmlBuilder<Message>,
) =>
  h.keyed('li')(
    caseFile.id,
    [h.Class('flex flex-col gap-3 py-4')],
    [
      h.div(
        [h.Class('flex items-baseline justify-between gap-4')],
        [
          h.span(
            [h.Class('flex min-w-0 flex-col')],
            [
              h.span([h.Class('text-lg font-medium')], [caseFile.reference]),
              h.span([h.Class('text-base text-msf-grey')], [caseFile.title]),
            ],
          ),
          smallButton(
            h,
            'Rename',
            Message.ClickedRename({ caseFileId: caseFile.id }),
            Option.some(`Rename case file ${caseFile.reference}`),
          ),
        ],
      ),
      Option.match(
        Option.filter(
          model.maybeRenaming,
          renaming => renaming.caseFileId === caseFile.id,
        ),
        {
          onNone: () => h.empty,
          onSome: renaming => renameForm(renaming, model, h),
        },
      ),
    ],
  )

const caseFilesPanel = (model: Model, h: HtmlBuilder<Message>) =>
  panel(
    h,
    'Case files',
    [
      Array.match(model.caseFiles, {
        onEmpty: () =>
          h.p(
            [h.Class('text-lg text-msf-grey')],
            ['No case files yet. A case file is made with its first report.'],
          ),
        onNonEmpty: caseFiles =>
          h.ul(
            [
              h.AriaLabel('Case files'),
              h.Class(
                'flex flex-col divide-y divide-msf-line border-y border-msf-line',
              ),
            ],
            Array.map(caseFiles, caseFile => caseFileRow(caseFile, model, h)),
          ),
      }),
    ],
    Option.some(
      'Only authors of a report on a case file can change its title. The reference stays as it was written.',
    ),
  )

const unitChooser = (model: Model, h: HtmlBuilder<Message>) =>
  Array.length(model.units) > 1
    ? selectField(
        h,
        'reports-unit',
        'Unit',
        model.selectedUnit,
        Array.map(model.units, unit => ({
          value: unit.id,
          label: `${unit.name} (${unit.code})`,
        })),
        value => Message.SelectedUnit({ value }),
      )
    : h.empty

const dataView = (model: Model, h: HtmlBuilder<Message>) =>
  LoadState.match(model.dataLoad, {
    Loading: () => [loadingText(h, 'Loading the reports.')],
    Failed: ({ failure }) =>
      failure._tag === 'NotAllowed'
        ? [
            h.p(
              [h.Role('alert'), h.Class('text-lg font-medium text-msf-alert')],
              [
                'You are not an author in this unit. An administrator can grant you that.',
              ],
            ),
          ]
        : [
            h.p(
              [
                h.Role('alert'),
                h.Class('text-base font-medium text-msf-alert'),
              ],
              [failureText(failure)],
            ),
          ],
    Loaded: () => [
      reportsPanel(model, h),
      createPanel(model, h),
      caseFilesPanel(model, h),
    ],
  })

export const view = Submodel.defineView<Model, Message>((model, h) =>
  LoadState.match(model.load, {
    Loading: () =>
      pageShell(h, 'Reports', 'Reports', '', [loadingText(h, 'Loading.')]),
    Failed: ({ failure }) =>
      pageShell(h, 'Reports', 'Reports', '', [
        failureAlert(h, failure),
        smallButton(h, 'Try again', Message.ClickedRetryLoad()),
      ]),
    Loaded: () =>
      Array.isReadonlyArrayEmpty(model.units)
        ? pageShell(h, 'Reports', 'Reports', '', [
            h.p(
              [h.Class('text-lg text-msf-ink')],
              [
                'There is no unit yet. An administrator creates units and grants the author capability.',
              ],
            ),
          ])
        : pageShell(
            h,
            'Reports',
            'Reports',
            'Write reports from a template, privately, and see where each one is.',
            [unitChooser(model, h), ...dataView(model, h)],
          ),
  }),
)
