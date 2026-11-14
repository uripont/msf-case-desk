import { clsx } from 'clsx'
import { Array, Effect, Option, Schema } from 'effect'
import { Command, Submodel, Update } from 'foldkit'
import { Html, HtmlBuilder } from 'foldkit/html'
import { defineMessageUnion } from 'foldkit/message'
import { modifyFields } from 'foldkit/struct'

import { TemplateSummary, TemplateVersionRecord } from '@case-desk/domain'

import { AppRoute, pathOf } from '../route'
import { focusRing } from '../style'
import { withQuoroom } from './api'
import { Failure, failureOf, failureText } from './failure'
import { FormState, formStatus, isSubmitting } from './formState'
import {
  alertText,
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

// NOTE: The template list of a template editor (stage 9a): every template
// with its state and versions, a new blank draft, a copy of any template
// (built-ins too) as a new draft, the next version of a published template,
// and retiring one. Retiring only stops new reports from starting on it;
// reports that already use a version keep reading it.

// MODEL

export const CreatedDraft = Schema.Struct({
  templateId: Schema.String,
  version: Schema.Int,
  name: Schema.String,
})
export type CreatedDraft = typeof CreatedDraft.Type

export const Model = Schema.Struct({
  origin: Schema.String,
  load: LoadState,
  templates: Schema.Array(TemplateSummary),
  newName: Schema.String,
  newForm: FormState,
  copySource: Schema.String,
  copyName: Schema.String,
  copyForm: FormState,
  maybeCreated: Schema.Option(CreatedDraft),
  maybeConfirmRetire: Schema.Option(Schema.String),
  maybeBusy: Schema.Option(Schema.String),
  maybeNotice: Schema.Option(Schema.String),
  maybeActionFailure: Schema.Option(Failure),
})
export type Model = typeof Model.Type

export const initialModel = Model.make({
  origin: '',
  load: LoadState.Loading(),
  templates: [],
  newName: '',
  newForm: FormState.Editing(),
  copySource: '',
  copyName: '',
  copyForm: FormState.Editing(),
  maybeCreated: Option.none(),
  maybeConfirmRetire: Option.none(),
  maybeBusy: Option.none(),
  maybeNotice: Option.none(),
  maybeActionFailure: Option.none(),
})

// MESSAGE

export const Message = defineMessageUnion({
  SucceededLoadTemplates: { templates: Schema.Array(TemplateSummary) },
  FailedLoadTemplates: { failure: Failure },
  ClickedRetryLoad: {},
  UpdatedNewName: { value: Schema.String },
  SubmittedNew: {},
  SelectedCopySource: { value: Schema.String },
  UpdatedCopyName: { value: Schema.String },
  SubmittedCopy: {},
  ClickedNewVersion: { templateId: Schema.String, version: Schema.Int },
  SucceededCreateDraft: { record: TemplateVersionRecord, form: Schema.String },
  FailedCreateDraft: { failure: Failure, form: Schema.String },
  AskedRetire: { templateId: Schema.String },
  CancelledRetire: {},
  ConfirmedRetire: { templateId: Schema.String },
  SucceededRetire: { summary: TemplateSummary },
  FailedRetire: { failure: Failure },
})
export type Message = typeof Message.Type

const NEW_FORM = 'new'
const COPY_FORM = 'copy'
const VERSION_FORM = 'version'

// COMMAND

export const LoadTemplates = Command.define('LoadTemplates', {
  messages: [Message.SucceededLoadTemplates, Message.FailedLoadTemplates],
  execute: withQuoroom(client => client.ListTemplates()).pipe(
    Effect.map(templates => Message.SucceededLoadTemplates({ templates })),
    Effect.catch(error =>
      Effect.succeed(Message.FailedLoadTemplates({ failure: failureOf(error) })),
    ),
  ),
})

export const CreateTemplateDraft = Command.define('CreateTemplateDraft', {
  args: {
    form: Schema.String,
    copyTemplateId: Schema.String,
    copyVersion: Schema.Int,
    name: Schema.String,
  },
  messages: [Message.SucceededCreateDraft, Message.FailedCreateDraft],
  execute: ({ form, copyTemplateId, copyVersion, name }) =>
    withQuoroom(client =>
      client.CreateTemplateDraft({
        ...(copyTemplateId === ''
          ? {}
          : { copyOf: { templateId: copyTemplateId, version: copyVersion } }),
        ...(name === '' ? {} : { name }),
      }),
    ).pipe(
      Effect.map(record => Message.SucceededCreateDraft({ record, form })),
      Effect.catch(error =>
        Effect.succeed(
          Message.FailedCreateDraft({ failure: failureOf(error), form }),
        ),
      ),
    ),
})

export const RetireTemplate = Command.define('RetireTemplate', {
  args: { templateId: Schema.String },
  messages: [Message.SucceededRetire, Message.FailedRetire],
  execute: ({ templateId }) =>
    withQuoroom(client => client.RetireTemplate({ templateId })).pipe(
      Effect.map(summary => Message.SucceededRetire({ summary })),
      Effect.catch(error =>
        Effect.succeed(Message.FailedRetire({ failure: failureOf(error) })),
      ),
    ),
})

// UPDATE

export const enter = (
  model: Model,
  origin: string,
): Update.Return<Model, Message> => ({
  model: modifyFields(model, {
    origin: () => origin,
    load: () => LoadState.Loading(),
    maybeCreated: () => Option.none(),
    maybeConfirmRetire: () => Option.none(),
    maybeNotice: () => Option.none(),
    maybeActionFailure: () => Option.none(),
  }),
  commands: [LoadTemplates()],
})

export const loadedTemplates = (templates: ReadonlyArray<TemplateSummary>): Message =>
  Message.SucceededLoadTemplates({ templates })

// NOTE: the version a copy starts from: the published one, else the latest.
export const sourceVersionOf = (summary: TemplateSummary): number =>
  summary.publishedVersion ?? summary.latestVersion

export const stateText = (summary: TemplateSummary): string => {
  if (summary.retired) return `Retired, last version ${summary.latestVersion}`
  const published =
    summary.publishedVersion === undefined
      ? 'Not published yet'
      : `Published, version ${summary.publishedVersion}`
  return summary.hasDraft
    ? `${published}. Draft of version ${summary.latestVersion} in progress`
    : published
}

const upsert = (
  templates: ReadonlyArray<TemplateSummary>,
  summary: TemplateSummary,
): ReadonlyArray<TemplateSummary> =>
  Array.some(templates, entry => entry.id === summary.id)
    ? Array.map(templates, entry => (entry.id === summary.id ? summary : entry))
    : [...templates, summary]

export const update = (
  model: Model,
  message: Message,
): Update.Return<Model, Message> =>
  Message.match<Update.Return<Model, Message>>(message, {
    SucceededLoadTemplates: ({ templates }) => ({
      model: modifyFields(model, {
        load: () => LoadState.Loaded(),
        templates: () => templates,
        copySource: current =>
          Array.some(templates, entry => entry.id === current)
            ? current
            : (templates[0]?.id ?? ''),
      }),
    }),
    FailedLoadTemplates: ({ failure }) => ({
      model: modifyFields(model, { load: () => LoadState.Failed({ failure }) }),
    }),
    ClickedRetryLoad: () => ({
      model: modifyFields(model, { load: () => LoadState.Loading() }),
      commands: [LoadTemplates()],
    }),
    UpdatedNewName: ({ value }) => ({
      model: modifyFields(model, {
        newName: () => value,
        newForm: () => FormState.Editing(),
      }),
    }),
    SubmittedNew: () => {
      const name = model.newName.trim()
      return name === ''
        ? {
            model: modifyFields(model, {
              newForm: () => FormState.Invalid({ message: 'Give it a name.' }),
            }),
          }
        : {
            model: modifyFields(model, {
              newForm: () => FormState.Submitting(),
              maybeCreated: () => Option.none(),
            }),
            commands: [
              CreateTemplateDraft({
                form: NEW_FORM,
                copyTemplateId: '',
                copyVersion: 1,
                name,
              }),
            ],
          }
    },
    SelectedCopySource: ({ value }) => ({
      model: modifyFields(model, { copySource: () => value }),
    }),
    UpdatedCopyName: ({ value }) => ({
      model: modifyFields(model, {
        copyName: () => value,
        copyForm: () => FormState.Editing(),
      }),
    }),
    SubmittedCopy: () => {
      const name = model.copyName.trim()
      const source = Array.findFirst(
        model.templates,
        entry => entry.id === model.copySource,
      )
      if (name === '') {
        return {
          model: modifyFields(model, {
            copyForm: () => FormState.Invalid({ message: 'Name the copy.' }),
          }),
        }
      }
      return Option.match(source, {
        onNone: () => ({
          model: modifyFields(model, {
            copyForm: () =>
              FormState.Invalid({ message: 'Choose a template to copy.' }),
          }),
        }),
        onSome: summary => ({
          model: modifyFields(model, {
            copyForm: () => FormState.Submitting(),
            maybeCreated: () => Option.none(),
          }),
          commands: [
            CreateTemplateDraft({
              form: COPY_FORM,
              copyTemplateId: summary.id,
              copyVersion: sourceVersionOf(summary),
              name,
            }),
          ],
        }),
      })
    },
    ClickedNewVersion: ({ templateId, version }) =>
      Option.isSome(model.maybeBusy)
        ? { model }
        : {
            model: modifyFields(model, {
              maybeBusy: () => Option.some(templateId),
              maybeCreated: () => Option.none(),
              maybeActionFailure: () => Option.none(),
            }),
            commands: [
              CreateTemplateDraft({
                form: VERSION_FORM,
                copyTemplateId: templateId,
                copyVersion: version,
                name: '',
              }),
            ],
          },
    SucceededCreateDraft: ({ record, form }) => ({
      model: modifyFields(model, {
        newName: current => (form === NEW_FORM ? '' : current),
        copyName: current => (form === COPY_FORM ? '' : current),
        newForm: () => FormState.Editing(),
        copyForm: () => FormState.Editing(),
        maybeBusy: () => Option.none(),
        maybeCreated: () =>
          Option.some({
            templateId: record.templateId,
            version: record.version,
            name: record.template.name,
          }),
      }),
      commands: [LoadTemplates()],
    }),
    FailedCreateDraft: ({ failure, form }) => ({
      model: modifyFields(model, {
        newForm: current =>
          form === NEW_FORM ? FormState.Failed({ failure }) : current,
        copyForm: current =>
          form === COPY_FORM ? FormState.Failed({ failure }) : current,
        maybeBusy: () => Option.none(),
        maybeActionFailure: () =>
          form === VERSION_FORM ? Option.some(failure) : Option.none(),
      }),
    }),
    AskedRetire: ({ templateId }) => ({
      model: modifyFields(model, {
        maybeConfirmRetire: () => Option.some(templateId),
      }),
    }),
    CancelledRetire: () => ({
      model: modifyFields(model, { maybeConfirmRetire: () => Option.none() }),
    }),
    ConfirmedRetire: ({ templateId }) => ({
      model: modifyFields(model, {
        maybeConfirmRetire: () => Option.none(),
        maybeBusy: () => Option.some(templateId),
        maybeActionFailure: () => Option.none(),
      }),
      commands: [RetireTemplate({ templateId })],
    }),
    SucceededRetire: ({ summary }) => ({
      model: modifyFields(model, {
        templates: templates => upsert(templates, summary),
        maybeBusy: () => Option.none(),
        maybeNotice: () =>
          Option.some(
            `${summary.name} is retired. Reports already started on it keep working.`,
          ),
      }),
    }),
    FailedRetire: ({ failure }) => ({
      model: modifyFields(model, {
        maybeBusy: () => Option.none(),
        maybeActionFailure: () => Option.some(failure),
      }),
    }),
  })

// VIEW

export const editorPath = (templateId: string, version: number): string =>
  pathOf(AppRoute.TemplateEditor({ templateId, version }))

const rowView = (
  h: HtmlBuilder<Message>,
  model: Model,
  summary: TemplateSummary,
): Html => {
  const busy = Option.isSome(model.maybeBusy)
  const confirming = Option.exists(
    model.maybeConfirmRetire,
    id => id === summary.id,
  )
  const published = summary.publishedVersion
  return h.keyed('li')(
    summary.id,
    [
      h.Class('flex flex-col gap-3 py-5'),
      h.DataAttribute('template-id', summary.id),
    ],
    [
      h.div(
        [h.Class('flex flex-col gap-1')],
        [
          h.p(
            [h.Class('text-xl font-bold text-msf-black')],
            [summary.builtIn ? `${summary.name} (built in)` : summary.name],
          ),
          h.p([h.Class('text-base text-msf-grey')], [stateText(summary)]),
        ],
      ),
      h.div(
        [h.Class('flex flex-wrap items-center gap-3')],
        [
          ...(summary.hasDraft
            ? [
                h.a(
                  [
                    h.Href(editorPath(summary.id, summary.latestVersion)),
                    h.AriaLabel(`Edit the draft of ${summary.name}`),
                    h.Class(
                      clsx(
                        'inline-flex h-10 items-center border border-msf-ink px-3 text-base text-msf-ink hover:border-msf-red hover:text-msf-red',
                        focusRing,
                      ),
                    ),
                  ],
                  ['Edit the draft'],
                ),
              ]
            : []),
          ...(published === undefined
            ? []
            : [
                h.a(
                  [
                    h.Href(editorPath(summary.id, published)),
                    h.AriaLabel(
                      `Open version ${published} of ${summary.name}`,
                    ),
                    h.Class(
                      clsx(
                        'inline-flex h-10 items-center border border-msf-line px-3 text-base text-msf-ink hover:border-msf-red hover:text-msf-red',
                        focusRing,
                      ),
                    ),
                  ],
                  [`Open version ${published}`],
                ),
              ]),
          ...(published !== undefined && !summary.hasDraft
            ? [
                smallButton(
                  h,
                  busy ? 'Working.' : 'Start a new version',
                  Message.ClickedNewVersion({
                    templateId: summary.id,
                    version: published,
                  }),
                  Option.some(`Start a new version of ${summary.name}`),
                ),
              ]
            : []),
          ...(published !== undefined && !confirming
            ? [
                smallButton(
                  h,
                  'Retire',
                  Message.AskedRetire({ templateId: summary.id }),
                  Option.some(`Retire ${summary.name}`),
                ),
              ]
            : []),
        ],
      ),
      confirming
        ? h.div(
            [
              h.Role('alertdialog'),
              h.AriaLabel(`Retire ${summary.name}?`),
              h.Class('flex flex-col gap-3 border border-msf-alert p-4'),
            ],
            [
              h.p(
                [h.Class('text-base text-msf-ink')],
                [
                  `Retire ${summary.name}? No new report can start on it. Reports already started keep working and keep their version.`,
                ],
              ),
              h.div(
                [h.Class('flex flex-wrap gap-3')],
                [
                  smallButton(
                    h,
                    'Retire it',
                    Message.ConfirmedRetire({ templateId: summary.id }),
                    Option.some(`Confirm retiring ${summary.name}`),
                  ),
                  smallButton(h, 'Keep it', Message.CancelledRetire()),
                ],
              ),
            ],
          )
        : h.empty,
    ],
  )
}

const createdView = (h: HtmlBuilder<Message>, created: CreatedDraft): Html =>
  h.div(
    [h.Role('status'), h.Class('flex flex-col gap-2 border border-msf-ink p-4')],
    [
      h.p(
        [h.Class('text-base text-msf-ink')],
        [`A draft of ${created.name} was made (version ${created.version}).`],
      ),
      h.a(
        [
          h.Href(editorPath(created.templateId, created.version)),
          h.Class(clsx('self-start text-lg text-msf-ink underline', focusRing)),
        ],
        ['Open the draft'],
      ),
    ],
  )

const loaded = (h: HtmlBuilder<Message>, model: Model): ReadonlyArray<Html> => [
  Option.match(model.maybeCreated, {
    onNone: () => h.empty,
    onSome: created => createdView(h, created),
  }),
  Option.match(model.maybeNotice, {
    onNone: () => h.empty,
    onSome: notice => statusText(h, notice),
  }),
  Option.match(model.maybeActionFailure, {
    onNone: () => h.empty,
    onSome: failure => alertText(h, failureText(failure)),
  }),
  panel(
    h,
    'Templates',
    [
      Array.match(model.templates, {
        onEmpty: () =>
          h.p([h.Class('text-lg text-msf-grey')], ['There are no templates.']),
        onNonEmpty: templates =>
          h.ul(
            [
              h.AriaLabel('Templates'),
              h.Class(
                'flex flex-col divide-y divide-msf-line border-y border-msf-line',
              ),
            ],
            Array.map(templates, summary => rowView(h, model, summary)),
          ),
      }),
    ],
    Option.some(
      'A template is the structure of a report. Publishing it makes a version; reports keep the version they started with.',
    ),
  ),
  panel(h, 'Copy a template', [
    h.form(
      [
        h.AriaLabel('Copy a template'),
        h.Class('flex max-w-xl flex-col gap-4'),
        h.OnSubmit(Message.SubmittedCopy()),
      ],
      [
        selectField(
          h,
          'copy-source',
          'Template to copy',
          model.copySource,
          Array.map(model.templates, summary => ({
            value: summary.id,
            label: summary.name,
          })),
          value => Message.SelectedCopySource({ value }),
        ),
        textField(h, {
          id: 'copy-name',
          label: 'Name of the copy',
          value: model.copyName,
          onInput: value => Message.UpdatedCopyName({ value }),
        }),
        submitButton(
          h,
          'Copy into a new draft',
          isSubmitting(model.copyForm),
          'Copying.',
        ),
        formStatus(h, model.copyForm, 'Copying.'),
      ],
    ),
  ]),
  panel(h, 'Start from nothing', [
    h.form(
      [
        h.AriaLabel('New blank template'),
        h.Class('flex max-w-xl flex-col gap-4'),
        h.OnSubmit(Message.SubmittedNew()),
      ],
      [
        textField(h, {
          id: 'new-name',
          label: 'Name of the new template',
          value: model.newName,
          onInput: value => Message.UpdatedNewName({ value }),
        }),
        submitButton(
          h,
          'Make a blank draft',
          isSubmitting(model.newForm),
          'Making.',
        ),
        formStatus(h, model.newForm, 'Making.'),
      ],
    ),
  ]),
]

export const view = Submodel.defineView<Model, Message>((model, h) =>
  pageShell(
    h,
    'Templates',
    'Templates',
    'Copy a template, edit it, and publish a version. Published versions never change.',
    LoadState.match(model.load, {
      Loading: () => [loadingText(h, 'Loading.')],
      Failed: ({ failure }) => [
        alertText(h, failureText(failure)),
        smallButton(h, 'Try again', Message.ClickedRetryLoad()),
      ],
      Loaded: () => loaded(h, model),
    }),
  ),
)
