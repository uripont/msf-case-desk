import { clsx } from 'clsx'
import { Array, Effect, Option, Result, Schema, Stream } from 'effect'
import { Command, Dom, Submodel, Subscription, Update } from 'foldkit'
import { Html, HtmlBuilder } from 'foldkit/html'
import { defineMessageUnion } from 'foldkit/message'
import { defineTaggedUnion } from 'foldkit/schema'
import { modifyFields } from 'foldkit/struct'

import {
  DRAFTING_REQUIRED_PERMISSIONS,
  FormEdit,
  type FormItem,
  type FormOption,
  type FormProblem,
  type FormRole,
  type FormSection,
  ITEM_TYPES,
  MAX_SECTION_DEPTH,
  type Permission,
  type Section,
  Template,
  TemplateChange,
  TemplateForm,
  TemplateVersionRecord,
  applyEdit,
  blankTemplate,
  diffTemplates,
  formProblems,
  formatNumber,
  freshId,
  savableTemplate,
  templateOfForm,
  templateToForm,
} from '@case-desk/domain'

import { AppRoute, pathOf } from '../route'
import {
  fieldClassName,
  focusRing,
  labelClassName,
  textAreaClassName,
} from '../style'
import { withQuoroom } from './api'
import { readOnlySection } from './contentView'
import { Failure, failureOf, failureText, isStaleSave } from './failure'
import {
  alertText,
  checkboxField,
  loadingText,
  selectField,
  smallButton,
  statusText,
} from './ui'
import { LoadState } from './unit'

// NOTE: The template editor (stage 9b and 9c): the draft is held as the flat
// form model of the domain, every change is one `FormEdit` applied by the
// domain, and what is wrong is `formProblems`, shown next to the row it is
// about. A draft is saved on request (it only has to fit the schema); it is
// published only without problems, after the person has seen what changed
// since the previous version. A published version is shown read-only.

// MODEL

export const EditorScope = Schema.Struct({
  templateId: Schema.String,
  version: Schema.Int,
  generation: Schema.Int,
})
export type EditorScope = typeof EditorScope.Type

export const SaveState = defineTaggedUnion({
  Clean: {},
  Dirty: {},
  Saving: {},
  Saved: {},
  Failed: { failure: Failure },
  Stale: {},
})
export type SaveState = typeof SaveState.Type

export const PublishState = defineTaggedUnion({
  Idle: {},
  Preparing: {},
  Reviewing: { changes: Schema.Array(TemplateChange) },
  Publishing: {},
  Published: { changes: Schema.Array(TemplateChange) },
  Failed: { failure: Failure },
})
export type PublishState = typeof PublishState.Type

export const Mode = Schema.Literals(['edit', 'preview'])
export type Mode = typeof Mode.Type

export const RemoveKind = Schema.Literals(['section', 'item'])

export const PendingRemove = Schema.Struct({
  kind: RemoveKind,
  id: Schema.String,
})

export const Model = Schema.Struct({
  origin: Schema.String,
  templateId: Schema.String,
  version: Schema.Int,
  generation: Schema.Int,
  load: LoadState,
  maybeRecord: Schema.Option(TemplateVersionRecord),
  form: TemplateForm,
  // NOTE: the number the next new ID is searched from, and how many edits
  // were made, so a save that finishes after more edits does not say "saved".
  idCounter: Schema.Int,
  edits: Schema.Int,
  newItemType: Schema.Literals(ITEM_TYPES),
  expanded: Schema.Array(Schema.String),
  save: SaveState,
  publish: PublishState,
  mode: Mode,
  maybeConfirmRemove: Schema.Option(PendingRemove),
  maybeNotice: Schema.Option(Schema.String),
  maybeNewDraft: Schema.Option(Schema.Int),
})
export type Model = typeof Model.Type

// NOTE: Panels and section cards fold away (stage 9d): the long form is
// usable only if most of it is closed. Closed by default, except the sections
// panel, and what is opened stays open. A panel or a section with a problem
// is always shown open, so an error is never hidden.
export const SECTIONS_PANEL = 'panel:sections'

export const BLANK_FORM: TemplateForm = templateToForm(
  blankTemplate('template', 'Template'),
)

export const initialModel = Model.make({
  origin: '',
  templateId: '',
  version: 1,
  generation: 0,
  load: LoadState.Loading(),
  maybeRecord: Option.none(),
  form: BLANK_FORM,
  idCounter: 1,
  edits: 0,
  newItemType: 'text',
  expanded: [SECTIONS_PANEL],
  save: SaveState.Clean(),
  publish: PublishState.Idle(),
  mode: 'edit',
  maybeConfirmRemove: Option.none(),
  maybeNotice: Option.none(),
  maybeNewDraft: Option.none(),
})

export const AddKind = Schema.Literals([
  'section',
  'subsection',
  'conclusion',
  'item',
  'option',
  'reviewing_role',
  'drafting_role',
])
export type AddKind = typeof AddKind.Type

// MESSAGE

export const Message = defineMessageUnion({
  SucceededLoadVersion: { scope: EditorScope, record: TemplateVersionRecord },
  FailedLoadVersion: { scope: EditorScope, failure: Failure },
  ClickedRetryLoad: {},
  Edited: { edit: FormEdit },
  ClickedAdd: { kind: AddKind, parentId: Schema.String },
  SelectedNewItemType: { value: Schema.String },
  ToggledOpen: { key: Schema.String },
  AskedRemove: { kind: RemoveKind, id: Schema.String },
  CancelledRemove: {},
  ConfirmedRemove: {},
  ClickedSave: {},
  SucceededSave: {
    scope: EditorScope,
    record: TemplateVersionRecord,
    edits: Schema.Int,
  },
  FailedSave: { scope: EditorScope, failure: Failure, isStale: Schema.Boolean },
  ClickedReload: {},
  WarnedBeforeLeaving: {},
  ClickedMode: { mode: Mode },
  ClickedPublish: {},
  SucceededPrepare: {
    scope: EditorScope,
    record: TemplateVersionRecord,
    edits: Schema.Int,
    changes: Schema.Array(TemplateChange),
  },
  FailedPrepare: { scope: EditorScope, failure: Failure, isStale: Schema.Boolean },
  ClickedBackToEditing: {},
  ClickedConfirmPublish: {},
  SucceededPublish: {
    scope: EditorScope,
    record: TemplateVersionRecord,
    changes: Schema.Array(TemplateChange),
  },
  FailedPublish: { scope: EditorScope, failure: Failure, isStale: Schema.Boolean },
  ClickedNewVersion: {},
  SucceededNewVersion: { scope: EditorScope, record: TemplateVersionRecord },
  FailedNewVersion: { scope: EditorScope, failure: Failure },
})
export type Message = typeof Message.Type

// COMMAND

export const LoadTemplateVersion = Command.define('LoadTemplateVersion', {
  args: { scope: EditorScope },
  messages: [Message.SucceededLoadVersion, Message.FailedLoadVersion],
  execute: ({ scope }) =>
    withQuoroom(client =>
      client.GetTemplateVersion({
        templateId: scope.templateId,
        version: scope.version,
      }),
    ).pipe(
      Effect.map(record => Message.SucceededLoadVersion({ scope, record })),
      Effect.catch(error =>
        Effect.succeed(
          Message.FailedLoadVersion({ scope, failure: failureOf(error) }),
        ),
      ),
    ),
})

export const SaveTemplateDraft = Command.define('SaveTemplateDraft', {
  args: {
    scope: EditorScope,
    template: Template,
    edits: Schema.Int,
    draftRevision: Schema.Int,
  },
  messages: [Message.SucceededSave, Message.FailedSave],
  execute: ({ scope, template, edits, draftRevision }) =>
    withQuoroom(client =>
      client.SaveTemplateDraft({
        templateId: scope.templateId,
        version: scope.version,
        draftRevision,
        template,
      }),
    ).pipe(
      Effect.map(({ record }) =>
        Message.SucceededSave({ scope, record, edits }),
      ),
      Effect.catch(error =>
        Effect.succeed(
          Message.FailedSave({
            scope,
            failure: failureOf(error),
            isStale: isStaleSave(error),
          }),
        ),
      ),
    ),
})

// NOTE: saves the draft, then reads the version before it and works out what
// changed, which the person confirms before publishing.
export const PrepareTemplateDiff = Command.define('PrepareTemplateDiff', {
  args: {
    scope: EditorScope,
    template: Template,
    edits: Schema.Int,
    draftRevision: Schema.Int,
  },
  messages: [Message.SucceededPrepare, Message.FailedPrepare],
  execute: ({ scope, template, edits, draftRevision }) =>
    withQuoroom(client =>
      Effect.gen(function* () {
        const { record } = yield* client.SaveTemplateDraft({
          templateId: scope.templateId,
          version: scope.version,
          draftRevision,
          template,
        })
        const previous =
          scope.version > 1
            ? yield* client
                .GetTemplateVersion({
                  templateId: scope.templateId,
                  version: scope.version - 1,
                })
                .pipe(Effect.map(found => found.template))
            : undefined
        return { record, changes: diffTemplates(previous, template) }
      }),
    ).pipe(
      Effect.map(({ record, changes }) =>
        Message.SucceededPrepare({ scope, record, edits, changes }),
      ),
      Effect.catch(error =>
        Effect.succeed(
          Message.FailedPrepare({
            scope,
            failure: failureOf(error),
            isStale: isStaleSave(error),
          }),
        ),
      ),
    ),
})

export const PublishTemplateVersion = Command.define('PublishTemplateVersion', {
  args: { scope: EditorScope, draftRevision: Schema.Int },
  messages: [Message.SucceededPublish, Message.FailedPublish],
  execute: ({ scope, draftRevision }) =>
    withQuoroom(client =>
      client.PublishTemplateVersion({
        templateId: scope.templateId,
        version: scope.version,
        draftRevision,
      }),
    ).pipe(
      Effect.map(({ record, changes }) =>
        Message.SucceededPublish({ scope, record, changes }),
      ),
      Effect.catch(error =>
        Effect.succeed(
          Message.FailedPublish({
            scope,
            failure: failureOf(error),
            isStale: isStaleSave(error),
          }),
        ),
      ),
    ),
})

export const CreateNextTemplateVersion = Command.define(
  'CreateNextTemplateVersion',
  {
    args: { scope: EditorScope },
    messages: [Message.SucceededNewVersion, Message.FailedNewVersion],
    execute: ({ scope }) =>
      withQuoroom(client =>
        client.CreateTemplateDraft({
          copyOf: { templateId: scope.templateId, version: scope.version },
        }),
      ).pipe(
        Effect.map(record => Message.SucceededNewVersion({ scope, record })),
        Effect.catch(error =>
          Effect.succeed(
            Message.FailedNewVersion({ scope, failure: failureOf(error) }),
          ),
        ),
      ),
  },
)

// UPDATE

export const loadedVersion = (
  scope: EditorScope,
  record: TemplateVersionRecord,
): Message => Message.SucceededLoadVersion({ scope, record })

export const scopeOf = (model: Model): EditorScope => ({
  templateId: model.templateId,
  version: model.version,
  generation: model.generation,
})

const isCurrent = (model: Model, scope: EditorScope): boolean =>
  model.templateId === scope.templateId &&
  model.version === scope.version &&
  model.generation === scope.generation

export const isDraft = (model: Model): boolean =>
  Option.exists(model.maybeRecord, record => record.state === 'draft')

export const enter = (
  origin: string,
  templateId: string,
  version: number,
  generation: number,
): Update.Return<Model, Message> => {
  const fresh = modifyFields(initialModel, {
    origin: () => origin,
    templateId: () => templateId,
    version: () => version,
    generation: () => generation,
  })
  return {
    model: fresh,
    commands: [LoadTemplateVersion({ scope: scopeOf(fresh) })],
  }
}

export const cleared = (model: Model): Model =>
  modifyFields(initialModel, { generation: () => model.generation + 1 })

export const hasUnsavedEdits = (model: Model): boolean =>
  isDraft(model) &&
  (SaveState.guards.Dirty(model.save) ||
    SaveState.guards.Saving(model.save) ||
    SaveState.guards.Failed(model.save) ||
    SaveState.guards.Stale(model.save))

const draftRevisionOf = (model: Model): number =>
  Option.match(model.maybeRecord, {
    onNone: () => 0,
    onSome: record => record.draftRevision,
  })

const prefixOf = (kind: AddKind): string =>
  kind === 'section' || kind === 'subsection' || kind === 'conclusion'
    ? 'section'
    : kind === 'item'
      ? 'item'
      : kind === 'option'
        ? 'option'
        : 'role'

const addEditOf = (
  kind: AddKind,
  id: string,
  parentId: string,
  itemType: (typeof ITEM_TYPES)[number],
): FormEdit => {
  switch (kind) {
    case 'section':
      return { _tag: 'AddSection', id, parentId: null, isConclusion: false }
    case 'subsection':
      return { _tag: 'AddSection', id, parentId, isConclusion: false }
    case 'conclusion':
      return { _tag: 'AddSection', id, parentId: null, isConclusion: true }
    case 'item':
      return { _tag: 'AddItem', id, parentId, type: itemType }
    case 'option':
      return { _tag: 'AddOption', id, itemId: parentId }
    case 'reviewing_role':
      return { _tag: 'AddRole', id, kind: 'reviewing' }
    case 'drafting_role':
      return { _tag: 'AddRole', id, kind: 'drafting' }
  }
}

const edited = (model: Model, form: TemplateForm): Model =>
  modifyFields(model, {
    form: () => form,
    edits: count => count + 1,
    save: () => SaveState.Dirty(),
    publish: () => PublishState.Idle(),
    maybeNotice: () => Option.none(),
    maybeNewDraft: () => Option.none(),
  })

const problemsNotice =
  'Fix the problems marked in the form first. A draft can be saved once every field has the right shape, and published once nothing is marked.'

const withRecord = (model: Model, record: TemplateVersionRecord): Model =>
  modifyFields(model, { maybeRecord: () => Option.some(record) })

const updateCurrent = (
  model: Model,
  message: Message,
): Update.Return<Model, Message> =>
  Message.match<Update.Return<Model, Message>>(message, {
    SucceededLoadVersion: ({ record }) => ({
      model: modifyFields(model, {
        load: () => LoadState.Loaded(),
        maybeRecord: () => Option.some(record),
        form: () => templateToForm(record.template),
      }),
    }),
    FailedLoadVersion: ({ failure }) => ({
      model: modifyFields(model, { load: () => LoadState.Failed({ failure }) }),
    }),
    ClickedRetryLoad: () => ({
      model: modifyFields(model, { load: () => LoadState.Loading() }),
      commands: [LoadTemplateVersion({ scope: scopeOf(model) })],
    }),
    Edited: ({ edit }) =>
      isDraft(model)
        ? {
            model: modifyFields(edited(model, applyEdit(model.form, edit)), {
              expanded: keys =>
                edit._tag === 'Rename' && edit.scope === 'section'
                  ? Array.map(keys, key =>
                      key === `section:${edit.id}`
                        ? `section:${edit.newId}`
                        : key,
                    )
                  : keys,
            }),
          }
        : { model },
    ToggledOpen: ({ key }) => ({
      model: modifyFields(model, {
        expanded: keys =>
          Array.contains(keys, key)
            ? Array.filter(keys, entry => entry !== key)
            : [...keys, key],
      }),
    }),
    ClickedAdd: ({ kind, parentId }) => {
      if (!isDraft(model)) return { model }
      const id = freshId(model.form, prefixOf(kind), model.idCounter)
      const next = edited(
        model,
        applyEdit(model.form, addEditOf(kind, id, parentId, model.newItemType)),
      )
      const opened =
        kind === 'section' || kind === 'conclusion' || kind === 'subsection'
          ? [
              `section:${id}`,
              ...(parentId === '' ? [] : [`section:${parentId}`]),
            ]
          : parentId === ''
            ? []
            : [`section:${parentId}`]
      return {
        model: modifyFields(next, {
          idCounter: count => count + 1,
          expanded: keys => [
            ...keys,
            ...Array.filter(opened, key => !Array.contains(keys, key)),
          ],
        }),
      }
    },
    SelectedNewItemType: ({ value }) => ({
      model: modifyFields(model, {
        newItemType: current =>
          Array.findFirst(ITEM_TYPES, type => type === value).pipe(
            Option.getOrElse(() => current),
          ),
      }),
    }),
    AskedRemove: ({ kind, id }) => ({
      model: modifyFields(model, {
        maybeConfirmRemove: () => Option.some({ kind, id }),
      }),
    }),
    CancelledRemove: () => ({
      model: modifyFields(model, { maybeConfirmRemove: () => Option.none() }),
    }),
    ConfirmedRemove: () =>
      Option.match(model.maybeConfirmRemove, {
        onNone: () => ({ model }),
        onSome: ({ kind, id }) => ({
          model: modifyFields(
            edited(
              model,
              applyEdit(
                model.form,
                kind === 'section'
                  ? { _tag: 'RemoveSection', id }
                  : { _tag: 'RemoveItem', id },
              ),
            ),
            { maybeConfirmRemove: () => Option.none() },
          ),
        }),
      }),
    ClickedSave: () => {
      if (!isDraft(model) || SaveState.guards.Saving(model.save)) {
        return { model }
      }
      const template = savableTemplate(model.form)
      return Result.match(template, {
        onFailure: () => ({
          model: modifyFields(model, {
            maybeNotice: () => Option.some(problemsNotice),
          }),
        }),
        onSuccess: found => ({
          model: modifyFields(model, {
            save: () => SaveState.Saving(),
            maybeNotice: () => Option.none(),
          }),
          commands: [
            SaveTemplateDraft({
              scope: scopeOf(model),
              template: found,
              edits: model.edits,
              draftRevision: draftRevisionOf(model),
            }),
          ],
        }),
      })
    },
    SucceededSave: ({ record, edits }) => ({
      model: modifyFields(withRecord(model, record), {
        save: () =>
          edits === model.edits ? SaveState.Saved() : SaveState.Dirty(),
      }),
    }),
    FailedSave: ({ failure, isStale }) => ({
      model: modifyFields(model, {
        save: () => (isStale ? SaveState.Stale() : SaveState.Failed({ failure })),
      }),
    }),
    ClickedReload: () => ({
      model: modifyFields(model, {
        load: () => LoadState.Loading(),
        save: () => SaveState.Clean(),
        publish: () => PublishState.Idle(),
        generation: generation => generation + 1,
      }),
      commands: [
        LoadTemplateVersion({
          scope: { ...scopeOf(model), generation: model.generation + 1 },
        }),
      ],
    }),
    WarnedBeforeLeaving: () => ({ model }),
    ClickedMode: ({ mode }) => ({
      model: modifyFields(model, { mode: () => mode }),
    }),
    ClickedPublish: () => {
      if (!isDraft(model)) return { model }
      if (PublishState.guards.Preparing(model.publish)) return { model }
      const built = templateOfForm(model.form)
      return Result.match(built, {
        onFailure: () => ({
          model: modifyFields(model, {
            maybeNotice: () => Option.some(problemsNotice),
          }),
        }),
        onSuccess: template => ({
          model: modifyFields(model, {
            publish: () => PublishState.Preparing(),
            save: () => SaveState.Saving(),
            maybeNotice: () => Option.none(),
          }),
          commands: [
            PrepareTemplateDiff({
              scope: scopeOf(model),
              template,
              edits: model.edits,
              draftRevision: draftRevisionOf(model),
            }),
          ],
        }),
      })
    },
    SucceededPrepare: ({ record, edits, changes }) =>
      edits === model.edits
        ? {
            model: modifyFields(withRecord(model, record), {
              save: () => SaveState.Saved(),
              publish: () => PublishState.Reviewing({ changes }),
            }),
          }
        : {
            model: modifyFields(withRecord(model, record), {
              save: () => SaveState.Dirty(),
              publish: () => PublishState.Idle(),
              maybeNotice: () =>
                Option.some(
                  'The draft changed while it was being saved. Publish again to see the differences.',
                ),
            }),
          },
    FailedPrepare: ({ failure, isStale }) => ({
      model: modifyFields(model, {
        save: () => (isStale ? SaveState.Stale() : SaveState.Failed({ failure })),
        publish: () =>
          isStale ? PublishState.Idle() : PublishState.Failed({ failure }),
      }),
    }),
    ClickedBackToEditing: () => ({
      model: modifyFields(model, { publish: () => PublishState.Idle() }),
    }),
    ClickedConfirmPublish: () =>
      PublishState.guards.Reviewing(model.publish)
        ? {
            model: modifyFields(model, {
              publish: () => PublishState.Publishing(),
            }),
            commands: [
              PublishTemplateVersion({
                scope: scopeOf(model),
                draftRevision: draftRevisionOf(model),
              }),
            ],
          }
        : { model },
    SucceededPublish: ({ record, changes }) => ({
      model: modifyFields(withRecord(model, record), {
        publish: () => PublishState.Published({ changes }),
        save: () => SaveState.Clean(),
        form: () => templateToForm(record.template),
        maybeConfirmRemove: () => Option.none(),
      }),
    }),
    FailedPublish: ({ failure, isStale }) => ({
      model: modifyFields(model, {
        publish: () =>
          isStale ? PublishState.Idle() : PublishState.Failed({ failure }),
        save: current => (isStale ? SaveState.Stale() : current),
      }),
    }),
    ClickedNewVersion: () => ({
      model: modifyFields(model, { maybeNewDraft: () => Option.none() }),
      commands: [CreateNextTemplateVersion({ scope: scopeOf(model) })],
    }),
    SucceededNewVersion: ({ record }) => ({
      model: modifyFields(model, {
        maybeNewDraft: () => Option.some(record.version),
      }),
    }),
    FailedNewVersion: () => ({
      model: modifyFields(model, {
        maybeNotice: () =>
          Option.some(
            'A new version could not be made. There may be a draft already, or this is a built-in template, which can only be copied: open the template list.',
          ),
      }),
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
  update(model, Message.CancelledRemove())

// NOTE: Saves the draft again, for the question asked before the editor is
// left.
export const retrySave = (model: Model): Update.Return<Model, Message> =>
  update(model, Message.ClickedSave())

// VIEW

// NOTE: The view of the template editor. Every control sends one `Edited`
// Message with one `FormEdit`; what is wrong with a row is shown right under
// it, from `formProblems`.

type H = HtmlBuilder<Message>

const send = (edit: FormEdit): Message => Message.Edited({ edit })

const intOf = (value: string, fallback: number): number => {
  const parsed = Number.parseInt(value, 10)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback
}

const maybeIntOf = (value: string): number | null =>
  value.trim() === '' ? null : intOf(value, 0)

const pick = <A extends string>(
  values: ReadonlyArray<A>,
  value: string,
): Option.Option<A> => Array.findFirst(values, candidate => candidate === value)

const REQUIREMENTS = [
  { value: 'required', label: 'Required' },
  { value: 'optional', label: 'Optional' },
  {
    value: 'optional_with_reason',
    label: 'Optional, with a reason when left out',
  },
] as const

const ITEM_TYPE_LABELS: Readonly<Record<(typeof ITEM_TYPES)[number], string>> =
  {
    text: 'Short text',
    rich_text: 'Rich text',
    date: 'Date',
    select: 'Choice',
    people: 'People',
    case_value: 'Case value',
    signature: 'Signature',
    repeated: 'Repeated entries',
  }

const PERMISSION_LABELS: Readonly<Record<Permission, string>> = {
  edit: 'Edit working copies',
  share: 'Share drafts',
  publish: 'Publish revisions',
  manage_people: 'Manage people and aliases',
  comment_drafts: 'Comment on drafts',
  reply: 'Reply to comments',
  write_conclusion: 'Write the conclusion',
  comment: 'Comment',
  vote: 'Vote',
}

const DRAFTING_OPTIONAL: ReadonlyArray<Permission> = [
  'comment_drafts',
  'reply',
  'write_conclusion',
]

// ---- Problems -----------------------------------------------------------------

type Context = Readonly<{
  form: TemplateForm
  problems: ReadonlyArray<FormProblem>
  model: Model
  sectionsByParent: ReadonlyMap<string | null, ReadonlyArray<FormSection>>
  itemsByParent: ReadonlyMap<string, ReadonlyArray<FormItem>>
  optionsByItem: ReadonlyMap<string, ReadonlyArray<FormOption>>
  open: ReadonlySet<string>
}>

// NOTE: the panel a problem is shown in, and the sections that hold it (the
// section itself and the ones above it), so both are shown open.
const panelKeyOf = (problem: FormProblem): string => {
  const { scope, field } = problem.target
  if (scope === 'role') return 'panel:roles'
  if (scope === 'numbering') return 'panel:numbering'
  if (scope === 'section' || scope === 'item' || scope === 'option') {
    return SECTIONS_PANEL
  }
  if (scope === 'ending') return 'panel:ending'
  if (scope === 'cover') return 'panel:cover'
  if (scope === 'furniture') return 'panel:pages'
  if (field === 'roles') return 'panel:roles'
  if (field === 'numbering') return 'panel:numbering'
  if (field === 'sections') return SECTIONS_PANEL
  if (field === 'contentsDepth' || field === 'pageNumbering') {
    return 'panel:pages'
  }
  return 'panel:about'
}

const sectionKeysAbove = (
  form: TemplateForm,
  scope: FormProblem['target']['scope'],
  id: string,
): ReadonlyArray<string> => {
  const up = (
    kind: 'section' | 'item' | 'option',
    at: string,
    depth: number,
  ): ReadonlyArray<string> => {
    if (depth > 60) return []
    if (kind === 'option') {
      const option = form.options.find(entry => entry.id === at)
      return option === undefined ? [] : up('item', option.itemId, depth + 1)
    }
    if (kind === 'item') {
      const item = form.items.find(entry => entry.id === at)
      if (item === undefined) return []
      const parentIsSection = form.sections.some(
        entry => entry.id === item.parentId,
      )
      return up(parentIsSection ? 'section' : 'item', item.parentId, depth + 1)
    }
    const section = form.sections.find(entry => entry.id === at)
    if (section === undefined) return []
    return [
      `section:${section.id}`,
      ...(section.parentId === null
        ? []
        : up('section', section.parentId, depth + 1)),
    ]
  }
  return scope === 'section' || scope === 'item' || scope === 'option'
    ? up(scope, id, 0)
    : []
}

const openKeysOf = (
  model: Model,
  form: TemplateForm,
  problems: ReadonlyArray<FormProblem>,
): ReadonlySet<string> =>
  new Set([
    ...model.expanded,
    ...problems.flatMap(problem => [
      panelKeyOf(problem),
      ...sectionKeysAbove(form, problem.target.scope, problem.target.id),
    ]),
  ])

const groupBy = <A, K>(
  rows: ReadonlyArray<A>,
  key: (row: A) => K,
): ReadonlyMap<K, ReadonlyArray<A>> => {
  const groups = new Map<K, Array<A>>()
  rows.forEach(row => {
    groups.set(key(row), [...(groups.get(key(row)) ?? []), row])
  })
  return groups
}

const contextOf = (model: Model): Context => {
  const problems = formProblems(model.form)
  return {
    form: model.form,
    problems,
    open: openKeysOf(model, model.form, problems),
    model,
    sectionsByParent: groupBy(model.form.sections, row => row.parentId),
    itemsByParent: groupBy(model.form.items, row => row.parentId),
    optionsByItem: groupBy(model.form.options, row => row.itemId),
  }
}

const problemsAt = (
  context: Context,
  scope: FormProblem['target']['scope'],
  id = '',
): ReadonlyArray<FormProblem> =>
  Array.filter(
    context.problems,
    entry => entry.target.scope === scope && entry.target.id === id,
  )

const problemList = (h: H, found: ReadonlyArray<FormProblem>): Html =>
  Array.match(found, {
    onEmpty: () => h.empty,
    onNonEmpty: list =>
      h.ul(
        [h.Class('flex flex-col gap-1'), h.DataAttribute('problems', 'here')],
        Array.map(list, entry =>
          h.li(
            [
              h.Class('text-sm font-medium text-msf-alert'),
              h.DataAttribute('problem-code', entry.problem.code),
            ],
            [entry.problem.message],
          ),
        ),
      ),
  })

// ---- Controls -----------------------------------------------------------------

const controlLabel = (h: H, id: string, label: string): Html =>
  h.label([h.Class(clsx(labelClassName, 'text-sm')), h.For(id)], [label])

const input = (
  h: H,
  config: Readonly<{
    id: string
    label: string
    value: string
    onInput: (value: string) => Message
    type?: 'text' | 'number'
    hint?: string
    invalid?: boolean
    onChange?: boolean
    narrow?: boolean
  }>,
): Html =>
  h.div(
    [
      h.Class(
        clsx('flex min-w-0 flex-col gap-1', config.narrow ? 'w-28' : 'flex-1'),
      ),
    ],
    [
      controlLabel(h, config.id, config.label),
      config.hint === undefined
        ? h.empty
        : h.p([h.Class('text-sm text-msf-grey')], [config.hint]),
      h.input([
        h.Id(config.id),
        h.Type(config.type ?? 'text'),
        h.Value(config.value),
        h.Class(clsx(fieldClassName, 'h-10 text-base')),
        h.Autocomplete('off'),
        ...(config.invalid === true ? [h.AriaInvalid(true)] : []),
        ...(config.onChange === true
          ? [h.OnChange(config.onInput)]
          : [h.OnInput(config.onInput)]),
      ]),
    ],
  )

const area = (
  h: H,
  id: string,
  label: string,
  value: string,
  onInput: (value: string) => Message,
  hint?: string,
): Html =>
  h.div(
    [h.Class('flex min-w-0 flex-col gap-1')],
    [
      controlLabel(h, id, label),
      hint === undefined
        ? h.empty
        : h.p([h.Class('text-sm text-msf-grey')], [hint]),
      h.textarea([
        h.Id(id),
        h.Value(value),
        h.Class(clsx(textAreaClassName, 'min-h-16 text-base')),
        h.OnInput(onInput),
      ]),
    ],
  )

const choice = (
  h: H,
  id: string,
  label: string,
  selected: string,
  choices: ReadonlyArray<Readonly<{ value: string; label: string }>>,
  onChange: (value: string) => Message,
): Html => selectField(h, id, label, selected, choices, onChange)

const moveButtons = (
  h: H,
  what: string,
  up: Message,
  down: Message,
): ReadonlyArray<Html> => [
  smallButton(h, 'Up', up, Option.some(`Move ${what} up`)),
  smallButton(h, 'Down', down, Option.some(`Move ${what} down`)),
]

const row = (h: H, children: ReadonlyArray<Html>): Html =>
  h.div([h.Class('flex flex-wrap items-end gap-3')], children)

const card = (h: H, children: ReadonlyArray<Html>): Html =>
  h.div(
    [
      h.Class(
        'flex min-w-0 flex-col gap-3 border border-msf-line bg-white p-3 md:p-4',
      ),
    ],
    children,
  )

const toggleButton = (
  h: H,
  key: string,
  label: string,
  isOpen: boolean,
  locked: boolean,
  className: string,
): Html =>
  h.button(
    [
      h.Type('button'),
      h.AriaExpanded(isOpen),
      h.DataAttribute('toggle', key),
      h.Class(clsx(className, 'cursor-pointer text-left', focusRing)),
      ...(locked
        ? [h.Disabled(true)]
        : [h.OnClick(Message.ToggledOpen({ key }))]),
    ],
    [`${isOpen ? '\u25BE' : '\u25B8'} ${label}`],
  )

const panelOf = (
  h: H,
  context: Context,
  key: string,
  heading: string,
  note: string,
  children: ReadonlyArray<Html>,
): Html => {
  const isOpen = context.open.has(key)
  const locked = isOpen && !Array.contains(context.model.expanded, key)
  return h.section(
    [
      h.AriaLabel(heading),
      h.DataAttribute('panel', key),
      h.Class('flex flex-col gap-4 border-t-2 border-msf-ink pt-5'),
    ],
    [
      h.h2(
        [h.Class('text-2xl font-black tracking-tight')],
        [toggleButton(h, key, heading, isOpen, locked, 'w-full')],
      ),
      ...(isOpen
        ? [
            locked
              ? h.p(
                  [h.Class('text-sm font-medium text-msf-alert')],
                  ['Something here needs fixing, so it stays open.'],
                )
              : h.empty,
            note === ''
              ? h.empty
              : h.p(
                  [h.Class('-mt-2 text-pretty text-base text-msf-grey')],
                  [note],
                ),
            ...children,
          ]
        : []),
    ],
  )
}

// ---- About --------------------------------------------------------------------

const aboutPanel = (h: H, context: Context): Html => {
  const { form } = context
  const here = problemsAt(context, 'template')
  const on = (field: string) => here.some(entry => entry.target.field === field)
  return panelOf(h, context, 'panel:about', 'About this template', '', [
    row(h, [
      input(h, {
        id: 'template-name',
        label: 'Name',
        value: form.name,
        invalid: on('name'),
        onInput: value => send({ _tag: 'SetText', field: 'name', value }),
      }),
      input(h, {
        id: 'template-short-name',
        label: 'Short name',
        hint: 'Lower case letters, digits and hyphens. Used in file names.',
        value: form.shortName,
        invalid: on('shortName'),
        onInput: value => send({ _tag: 'SetText', field: 'shortName', value }),
      }),
    ]),
    input(h, {
      id: 'template-case-label',
      label: 'What the case reference is called',
      value: form.caseReferenceLabel,
      invalid: on('caseReferenceLabel'),
      onInput: value =>
        send({ _tag: 'SetText', field: 'caseReferenceLabel', value }),
    }),
    area(h, 'template-description', 'Description', form.description, value =>
      send({ _tag: 'SetText', field: 'description', value }),
    ),
    problemList(
      h,
      Array.filter(
        here,
        entry =>
          !['name', 'shortName', 'caseReferenceLabel', 'description'].includes(
            entry.target.field,
          ) &&
          entry.target.field !== 'roles' &&
          entry.target.field !== 'sections' &&
          entry.target.field !== 'contentsDepth' &&
          entry.target.field !== 'pageNumbering',
      ),
    ),
  ])
}

// ---- Roles --------------------------------------------------------------------

const rolePermissionBoxes = (h: H, role: FormRole): ReadonlyArray<Html> => {
  const list =
    role.kind === 'drafting'
      ? [...DRAFTING_REQUIRED_PERMISSIONS, ...DRAFTING_OPTIONAL]
      : (['comment', 'vote'] as const)
  return Array.map(list, permission => {
    const required =
      role.kind === 'drafting' &&
      DRAFTING_REQUIRED_PERMISSIONS.includes(permission)
    const id = `role-${role.id}-perm-${permission}`
    return h.div(
      [h.Class('flex items-center gap-2')],
      [
        h.label(
          [
            h.Class('flex cursor-pointer items-center gap-2 text-base'),
            h.For(id),
          ],
          [
            h.input([
              h.Id(id),
              h.Type('checkbox'),
              h.Class('size-5 shrink-0 accent-msf-red'),
              h.Checked(role.permissions.includes(permission)),
              h.Disabled(required),
              h.OnClick(
                send({ _tag: 'TogglePermission', id: role.id, permission }),
              ),
            ]),
            required
              ? `${PERMISSION_LABELS[permission]} (always)`
              : PERMISSION_LABELS[permission],
          ],
        ),
      ],
    )
  })
}

const roleCard = (h: H, context: Context, role: FormRole): Html => {
  const found = problemsAt(context, 'role', role.id)
  const votes = role.permissions.includes('vote')
  return h.keyed('li')(
    role.id,
    [h.Class('list-none'), h.DataAttribute('role-id', role.id)],
    [
      card(h, [
        row(h, [
          input(h, {
            id: `role-${role.id}-name`,
            label: 'Role name',
            value: role.name,
            invalid: found.some(entry => entry.target.field === 'name'),
            onInput: value => send({ _tag: 'SetRoleName', id: role.id, value }),
          }),
          input(h, {
            id: `role-${role.id}-id`,
            label: 'ID',
            value: role.id,
            onChange: true,
            narrow: true,
            onInput: value =>
              send({
                _tag: 'Rename',
                scope: 'role',
                id: role.id,
                newId: value,
              }),
          }),
          choice(
            h,
            `role-${role.id}-kind`,
            'Kind',
            role.kind,
            [
              { value: 'drafting', label: 'Drafting (writes the report)' },
              { value: 'reviewing', label: 'Reviewing (reads and answers)' },
            ],
            value =>
              Option.match(pick(['drafting', 'reviewing'] as const, value), {
                onNone: () =>
                  send({ _tag: 'SetRoleName', id: role.id, value: role.name }),
                onSome: kind =>
                  send({ _tag: 'SetRoleKind', id: role.id, value: kind }),
              }),
          ),
          role.kind === 'drafting'
            ? h.p(
                [h.Class('pb-2 text-base text-msf-ink')],
                ['Sees the full text.'],
              )
            : choice(
                h,
                `role-${role.id}-view`,
                'Sees',
                role.view,
                [
                  { value: 'redacted', label: 'The redacted text' },
                  { value: 'full', label: 'The full text' },
                ],
                value =>
                  Option.match(pick(['full', 'redacted'] as const, value), {
                    onNone: () =>
                      send({
                        _tag: 'SetRoleName',
                        id: role.id,
                        value: role.name,
                      }),
                    onSome: view =>
                      send({ _tag: 'SetRoleView', id: role.id, value: view }),
                  }),
              ),
        ]),
        h.div(
          [h.Class('flex flex-col gap-1')],
          [
            h.p([h.Class('text-sm font-medium text-msf-ink')], ['Permissions']),
            ...rolePermissionBoxes(h, role),
          ],
        ),
        role.kind === 'reviewing' && votes
          ? row(h, [
              choice(
                h,
                `role-${role.id}-approval`,
                'The role approves when',
                role.approvalKind === '' ? 'all' : role.approvalKind,
                [
                  { value: 'all', label: 'All of its people approve' },
                  { value: 'at_least', label: 'At least a number approve' },
                  { value: 'majority', label: 'A majority approve' },
                ],
                value =>
                  Option.match(
                    pick(['all', 'at_least', 'majority'] as const, value),
                    {
                      onNone: () =>
                        send({
                          _tag: 'SetRoleName',
                          id: role.id,
                          value: role.name,
                        }),
                      onSome: kind =>
                        send({
                          _tag: 'SetApproval',
                          id: role.id,
                          kind,
                          count: role.approvalCount,
                        }),
                    },
                  ),
              ),
              role.approvalKind === 'at_least'
                ? input(h, {
                    id: `role-${role.id}-count`,
                    label: 'How many',
                    type: 'number',
                    narrow: true,
                    value:
                      role.approvalCount === null
                        ? ''
                        : String(role.approvalCount),
                    invalid: found.some(
                      entry => entry.target.field === 'approval',
                    ),
                    onInput: value =>
                      send({
                        _tag: 'SetApproval',
                        id: role.id,
                        kind: 'at_least',
                        count: intOf(value, 0),
                      }),
                  })
                : h.empty,
            ])
          : h.empty,
        problemList(h, found),
        row(h, [
          ...moveButtons(
            h,
            `role ${role.name}`,
            send({ _tag: 'MoveRole', id: role.id, by: -1 }),
            send({ _tag: 'MoveRole', id: role.id, by: 1 }),
          ),
          smallButton(
            h,
            'Remove role',
            send({ _tag: 'RemoveRole', id: role.id }),
            Option.some(`Remove role ${role.name}`),
          ),
        ]),
      ]),
    ],
  )
}

const rolesPanel = (h: H, context: Context): Html =>
  panelOf(
    h,
    context,
    'panel:roles',
    'Roles and approval',
    'A report has one drafting role, which writes it, and any number of reviewing roles. A reviewing role that votes needs an approval rule; a round is decided when every voting role has met its rule.',
    [
      problemList(
        h,
        Array.filter(
          problemsAt(context, 'template'),
          entry => entry.target.field === 'roles',
        ),
      ),
      h.ul(
        [h.AriaLabel('Roles'), h.Class('flex flex-col gap-3')],
        Array.map(context.form.roles, role => roleCard(h, context, role)),
      ),
      row(h, [
        smallButton(
          h,
          'Add a reviewing role',
          Message.ClickedAdd({ kind: 'reviewing_role', parentId: '' }),
        ),
        smallButton(
          h,
          'Add a drafting role',
          Message.ClickedAdd({ kind: 'drafting_role', parentId: '' }),
        ),
      ]),
    ],
  )

// ---- Numbering ----------------------------------------------------------------

const numberingPanel = (h: H, context: Context): Html => {
  const levels = context.form.numbering
  return panelOf(
    h,
    context,
    'panel:numbering',
    'Numbering',
    'How sections are numbered, level by level. The first level numbers the top-level sections, the second their subsections, and so on. A section can also be left unnumbered.',
    [
      h.ul(
        [h.AriaLabel('Numbering levels'), h.Class('flex flex-col gap-3')],
        Array.map(levels, (level, index) => {
          const found = problemsAt(context, 'numbering', String(index))
          const change = (
            patch: Partial<{
              style: string
              letterCase: string
              suffix: string
            }>,
          ): Message => {
            const style = pick(
              ['arabic', 'roman', 'letters'] as const,
              patch.style ?? level.style,
            )
            const letterCase = pick(
              ['', 'upper', 'lower'] as const,
              patch.letterCase ?? level.letterCase,
            )
            const suffix = pick(
              ['.', ')', ''] as const,
              patch.suffix ?? level.suffix,
            )
            return send({
              _tag: 'SetNumberingLevel',
              level: index,
              style: Option.getOrElse(style, () => level.style),
              letterCase: Option.getOrElse(letterCase, () => level.letterCase),
              suffix: Option.getOrElse(suffix, () => level.suffix),
            })
          }
          return h.li(
            [
              h.Class('list-none'),
              h.DataAttribute('numbering-level', String(index + 1)),
            ],
            [
              card(h, [
                row(h, [
                  h.p(
                    [h.Class('pb-2 text-base font-medium text-msf-ink')],
                    [`Level ${index + 1}`],
                  ),
                  choice(
                    h,
                    `numbering-${index}-style`,
                    'Style',
                    level.style,
                    [
                      { value: 'arabic', label: '1, 2, 3' },
                      { value: 'roman', label: 'I, II, III' },
                      { value: 'letters', label: 'A, B, C' },
                    ],
                    value => change({ style: value }),
                  ),
                  level.style === 'arabic'
                    ? h.empty
                    : choice(
                        h,
                        `numbering-${index}-case`,
                        'Case',
                        level.letterCase === '' ? 'upper' : level.letterCase,
                        [
                          { value: 'upper', label: 'Upper case' },
                          { value: 'lower', label: 'Lower case' },
                        ],
                        value => change({ letterCase: value }),
                      ),
                  choice(
                    h,
                    `numbering-${index}-suffix`,
                    'After the number',
                    level.suffix,
                    [
                      { value: '.', label: 'A full stop' },
                      { value: ')', label: 'A bracket' },
                      { value: '', label: 'Nothing' },
                    ],
                    value => change({ suffix: value }),
                  ),
                ]),
                problemList(h, found),
              ]),
            ],
          )
        }),
      ),
      row(h, [
        smallButton(h, 'Add a level', send({ _tag: 'AddNumberingLevel' })),
        levels.length > 0
          ? smallButton(
              h,
              'Remove the last level',
              send({ _tag: 'RemoveNumberingLevel' }),
            )
          : h.empty,
      ]),
      problemList(
        h,
        Array.filter(
          problemsAt(context, 'template'),
          entry => entry.target.field === 'numbering',
        ),
      ),
    ],
  )
}

// ---- Items --------------------------------------------------------------------

const optionRow = (
  h: H,
  context: Context,
  item: FormItem,
  option: FormOption,
): Html => {
  const found = problemsAt(context, 'option', option.id)
  return h.keyed('li')(
    option.id,
    [h.Class('list-none'), h.DataAttribute('option-id', option.id)],
    [
      h.div(
        [h.Class('flex flex-col gap-2 border-l-2 border-msf-line pl-3')],
        [
          row(h, [
            input(h, {
              id: `option-${option.id}-label`,
              label: 'Option',
              value: option.label,
              invalid: found.some(entry => entry.target.field === 'label'),
              onInput: value =>
                send({
                  _tag: 'SetOptionText',
                  id: option.id,
                  field: 'label',
                  value,
                }),
            }),
            input(h, {
              id: `option-${option.id}-code`,
              label: 'Code (up to 8 characters)',
              value: option.code,
              narrow: true,
              invalid: found.some(entry => entry.target.field === 'code'),
              onInput: value =>
                send({
                  _tag: 'SetOptionText',
                  id: option.id,
                  field: 'code',
                  value,
                }),
            }),
            input(h, {
              id: `option-${option.id}-id`,
              label: 'ID',
              value: option.id,
              narrow: true,
              onChange: true,
              onInput: value =>
                send({
                  _tag: 'Rename',
                  scope: 'option',
                  id: option.id,
                  newId: value,
                }),
            }),
          ]),
          checkboxField(
            h,
            `option-${option.id}-end`,
            'Choosing this ends the report here',
            item.endOptionId === option.id,
            send({
              _tag: 'SetEndOption',
              id: item.id,
              optionId: item.endOptionId === option.id ? '' : option.id,
            }),
          ),
          problemList(h, found),
          row(h, [
            ...moveButtons(
              h,
              `option ${option.label}`,
              send({ _tag: 'MoveOption', id: option.id, by: -1 }),
              send({ _tag: 'MoveOption', id: option.id, by: 1 }),
            ),
            smallButton(
              h,
              'Remove',
              send({ _tag: 'RemoveOption', id: option.id }),
              Option.some(`Remove option ${option.label}`),
            ),
          ]),
        ],
      ),
    ],
  )
}

const addItemRow = (
  h: H,
  context: Context,
  parentId: string,
  name: string,
): Html =>
  row(h, [
    choice(
      h,
      `new-item-type-${parentId}`,
      'Kind of item to add',
      context.model.newItemType,
      Array.map(ITEM_TYPES, type => ({
        value: type,
        label: ITEM_TYPE_LABELS[type],
      })),
      value => Message.SelectedNewItemType({ value }),
    ),
    smallButton(
      h,
      'Add item',
      Message.ClickedAdd({ kind: 'item', parentId }),
      Option.some(`Add an item to ${name}`),
    ),
  ])

const confirmRemove = (
  h: H,
  context: Context,
  kind: 'section' | 'item',
  id: string,
  name: string,
): Html =>
  Option.exists(
    context.model.maybeConfirmRemove,
    pending => pending.kind === kind && pending.id === id,
  )
    ? h.div(
        [
          h.Role('alertdialog'),
          h.AriaLabel(`Remove ${name}?`),
          h.Class('flex flex-col gap-2 border border-msf-alert p-3'),
        ],
        [
          h.p(
            [h.Class('text-base text-msf-ink')],
            [
              kind === 'section'
                ? `Remove "${name}" with its subsections and items?`
                : `Remove "${name}" with everything inside it?`,
            ],
          ),
          row(h, [
            smallButton(
              h,
              'Remove it',
              Message.ConfirmedRemove(),
              Option.some(`Confirm removing ${name}`),
            ),
            smallButton(h, 'Keep it', Message.CancelledRemove()),
          ]),
        ],
      )
    : h.empty

const itemCard = (h: H, context: Context, item: FormItem): Html => {
  const found = problemsAt(context, 'item', item.id)
  const options = context.optionsByItem.get(item.id) ?? []
  const children = context.itemsByParent.get(item.id) ?? []
  const name = item.label === '' ? item.id : item.label
  return h.keyed('li')(
    item.id,
    [h.Class('list-none'), h.DataAttribute('item-id', item.id)],
    [
      card(h, [
        row(h, [
          input(h, {
            id: `item-${item.id}-label`,
            label: 'Label',
            value: item.label,
            invalid: found.some(entry => entry.target.field === 'label'),
            onInput: value =>
              send({ _tag: 'SetItemText', id: item.id, field: 'label', value }),
          }),
          choice(
            h,
            `item-${item.id}-type`,
            'Kind',
            item.type,
            Array.map(ITEM_TYPES, type => ({
              value: type,
              label: ITEM_TYPE_LABELS[type],
            })),
            value =>
              Option.match(pick(ITEM_TYPES, value), {
                onNone: () =>
                  send({
                    _tag: 'SetItemText',
                    id: item.id,
                    field: 'label',
                    value: item.label,
                  }),
                onSome: type =>
                  send({ _tag: 'SetItemType', id: item.id, type }),
              }),
          ),
          choice(
            h,
            `item-${item.id}-requirement`,
            'Filling it in is',
            item.requirement,
            REQUIREMENTS,
            value =>
              Option.match(
                pick(
                  ['required', 'optional', 'optional_with_reason'] as const,
                  value,
                ),
                {
                  onNone: () =>
                    send({
                      _tag: 'SetItemText',
                      id: item.id,
                      field: 'label',
                      value: item.label,
                    }),
                  onSome: requirement =>
                    send({
                      _tag: 'SetItemRequirement',
                      id: item.id,
                      value: requirement,
                    }),
                },
              ),
          ),
          input(h, {
            id: `item-${item.id}-id`,
            label: 'ID',
            value: item.id,
            narrow: true,
            onChange: true,
            onInput: value =>
              send({
                _tag: 'Rename',
                scope: 'item',
                id: item.id,
                newId: value,
              }),
          }),
        ]),
        area(
          h,
          `item-${item.id}-instruction`,
          'Instruction for the author (never part of the report)',
          item.instruction,
          value =>
            send({
              _tag: 'SetItemText',
              id: item.id,
              field: 'instruction',
              value,
            }),
        ),
        item.type === 'date'
          ? choice(
              h,
              `item-${item.id}-precision`,
              'Date to the',
              item.precision === '' ? 'day' : item.precision,
              [
                { value: 'day', label: 'Day' },
                { value: 'month', label: 'Month' },
              ],
              value =>
                send({
                  _tag: 'SetItemPrecision',
                  id: item.id,
                  value: value === 'month' ? 'month' : 'day',
                }),
            )
          : h.empty,
        item.type === 'case_value'
          ? choice(
              h,
              `item-${item.id}-field`,
              'Shows the case',
              item.field === '' ? 'reference' : item.field,
              [
                { value: 'reference', label: 'Reference' },
                { value: 'unit', label: 'Unit' },
                { value: 'title', label: 'Title' },
              ],
              value =>
                send({
                  _tag: 'SetItemField',
                  id: item.id,
                  value:
                    value === 'unit'
                      ? 'unit'
                      : value === 'title'
                        ? 'title'
                        : 'reference',
                }),
            )
          : h.empty,
        item.type === 'people'
          ? checkboxField(
              h,
              `item-${item.id}-multiple`,
              'More than one person can be named',
              item.multiple,
              send({
                _tag: 'SetItemMultiple',
                id: item.id,
                value: !item.multiple,
              }),
            )
          : h.empty,
        item.type === 'select'
          ? h.div(
              [h.Class('flex flex-col gap-3')],
              [
                checkboxField(
                  h,
                  `item-${item.id}-multiple`,
                  'More than one option can be chosen',
                  item.multiple,
                  send({
                    _tag: 'SetItemMultiple',
                    id: item.id,
                    value: !item.multiple,
                  }),
                ),
                h.ul(
                  [
                    h.AriaLabel(`Options of ${name}`),
                    h.Class('flex flex-col gap-3'),
                  ],
                  Array.map(options, option =>
                    optionRow(h, context, item, option),
                  ),
                ),
                row(h, [
                  smallButton(
                    h,
                    'Add option',
                    Message.ClickedAdd({ kind: 'option', parentId: item.id }),
                    Option.some(`Add an option to ${name}`),
                  ),
                ]),
              ],
            )
          : h.empty,
        item.type === 'repeated'
          ? h.div(
              [h.Class('flex flex-col gap-3 border-l-2 border-msf-ink pl-3')],
              [
                row(h, [
                  input(h, {
                    id: `item-${item.id}-entry-label`,
                    label: 'Each entry is called',
                    value: item.entryLabel,
                    invalid: found.some(
                      entry => entry.target.field === 'entryLabel',
                    ),
                    onInput: value =>
                      send({
                        _tag: 'SetItemText',
                        id: item.id,
                        field: 'entryLabel',
                        value,
                      }),
                  }),
                  input(h, {
                    id: `item-${item.id}-min`,
                    label: 'At least',
                    type: 'number',
                    narrow: true,
                    value: String(item.repeatMin),
                    onInput: value =>
                      send({
                        _tag: 'SetItemRepeat',
                        id: item.id,
                        min: intOf(value, 0),
                        max: item.repeatMax,
                      }),
                  }),
                  input(h, {
                    id: `item-${item.id}-max`,
                    label: 'At most (empty: no limit)',
                    type: 'number',
                    narrow: true,
                    value:
                      item.repeatMax === null ? '' : String(item.repeatMax),
                    onInput: value =>
                      send({
                        _tag: 'SetItemRepeat',
                        id: item.id,
                        min: item.repeatMin,
                        max: maybeIntOf(value),
                      }),
                  }),
                ]),
                h.ul(
                  [
                    h.AriaLabel(`Items inside ${name}`),
                    h.Class('flex flex-col gap-3'),
                  ],
                  Array.map(children, child => itemCard(h, context, child)),
                ),
                addItemRow(h, context, item.id, name),
              ],
            )
          : h.empty,
        problemList(h, found),
        confirmRemove(h, context, 'item', item.id, name),
        row(h, [
          ...moveButtons(
            h,
            `item ${name}`,
            send({ _tag: 'MoveItem', id: item.id, by: -1 }),
            send({ _tag: 'MoveItem', id: item.id, by: 1 }),
          ),
          smallButton(
            h,
            'Remove item',
            Message.AskedRemove({ kind: 'item', id: item.id }),
            Option.some(`Remove item ${name}`),
          ),
        ]),
      ]),
    ],
  )
}

// ---- Sections -----------------------------------------------------------------

const sectionCard = (
  h: H,
  context: Context,
  section: FormSection,
  depth: number,
): Html => {
  const found = problemsAt(context, 'section', section.id)
  const items = context.itemsByParent.get(section.id) ?? []
  const children = context.sectionsByParent.get(section.id) ?? []
  const name = section.title === '' ? section.id : section.title
  const kind = section.isConclusion
    ? 'Conclusion'
    : depth === 1
      ? 'Section'
      : 'Subsection'
  const sectionKey = `section:${section.id}`
  const isOpen = context.open.has(sectionKey)
  const locked = isOpen && !Array.contains(context.model.expanded, sectionKey)
  return h.keyed('li')(
    section.id,
    [h.Class('list-none'), h.DataAttribute('section-id', section.id)],
    [
      card(h, [
        h.div(
          [h.Class('flex flex-wrap items-baseline gap-x-3')],
          [
            h.p(
              [
                h.Class(
                  'text-sm font-bold uppercase tracking-wide text-msf-grey',
                ),
              ],
              [kind],
            ),
            toggleButton(
              h,
              sectionKey,
              isOpen ? `Close ${name}` : `Open ${name}`,
              isOpen,
              locked,
              'text-lg font-bold text-msf-black',
            ),
            locked
              ? h.span(
                  [h.Class('text-sm font-medium text-msf-alert')],
                  ['needs fixing'],
                )
              : h.empty,
          ],
        ),
        ...(isOpen
          ? [
              row(h, [
                input(h, {
                  id: `section-${section.id}-title`,
                  label: 'Title',
                  value: section.title,
                  invalid: found.some(entry => entry.target.field === 'title'),
                  onInput: value =>
                    send({
                      _tag: 'SetSectionText',
                      id: section.id,
                      field: 'title',
                      value,
                    }),
                }),
                choice(
                  h,
                  `section-${section.id}-requirement`,
                  'Filling it in is',
                  section.requirement,
                  REQUIREMENTS,
                  value =>
                    Option.match(
                      pick(
                        [
                          'required',
                          'optional',
                          'optional_with_reason',
                        ] as const,
                        value,
                      ),
                      {
                        onNone: () =>
                          send({
                            _tag: 'SetSectionText',
                            id: section.id,
                            field: 'title',
                            value: section.title,
                          }),
                        onSome: requirement =>
                          send({
                            _tag: 'SetSectionRequirement',
                            id: section.id,
                            value: requirement,
                          }),
                      },
                    ),
                ),
                input(h, {
                  id: `section-${section.id}-id`,
                  label: 'ID',
                  value: section.id,
                  narrow: true,
                  onChange: true,
                  onInput: value =>
                    send({
                      _tag: 'Rename',
                      scope: 'section',
                      id: section.id,
                      newId: value,
                    }),
                }),
              ]),
              h.div(
                [h.Class('flex flex-wrap gap-x-6 gap-y-2')],
                [
                  checkboxField(
                    h,
                    `section-${section.id}-numbered`,
                    'Numbered',
                    section.numbered,
                    send({
                      _tag: 'SetSectionFlag',
                      id: section.id,
                      flag: 'numbered',
                      value: !section.numbered,
                    }),
                  ),
                  depth === 1 && !section.isConclusion
                    ? checkboxField(
                        h,
                        `section-${section.id}-front`,
                        'Front matter (cover, contents, summary)',
                        section.frontMatter,
                        send({
                          _tag: 'SetSectionFlag',
                          id: section.id,
                          flag: 'frontMatter',
                          value: !section.frontMatter,
                        }),
                      )
                    : h.empty,
                  depth > 1
                    ? checkboxField(
                        h,
                        `section-${section.id}-repeatable`,
                        'Repeated: one subsection for each entry',
                        section.repeatable,
                        send({
                          _tag: 'SetSectionFlag',
                          id: section.id,
                          flag: 'repeatable',
                          value: !section.repeatable,
                        }),
                      )
                    : h.empty,
                ],
              ),
              section.repeatable
                ? row(h, [
                    input(h, {
                      id: `section-${section.id}-min`,
                      label: 'At least',
                      type: 'number',
                      narrow: true,
                      value: String(section.repeatMin),
                      onInput: value =>
                        send({
                          _tag: 'SetSectionRepeat',
                          id: section.id,
                          min: intOf(value, 0),
                          max: section.repeatMax,
                        }),
                    }),
                    input(h, {
                      id: `section-${section.id}-max`,
                      label: 'At most (empty: no limit)',
                      type: 'number',
                      narrow: true,
                      value:
                        section.repeatMax === null
                          ? ''
                          : String(section.repeatMax),
                      onInput: value =>
                        send({
                          _tag: 'SetSectionRepeat',
                          id: section.id,
                          min: section.repeatMin,
                          max: maybeIntOf(value),
                        }),
                    }),
                  ])
                : h.empty,
              area(
                h,
                `section-${section.id}-instruction`,
                'Instruction for the author (never part of the report)',
                section.instruction,
                value =>
                  send({
                    _tag: 'SetSectionText',
                    id: section.id,
                    field: 'instruction',
                    value,
                  }),
              ),
              problemList(h, found),
              h.ul(
                [
                  h.AriaLabel(`Items of ${name}`),
                  h.Class('flex flex-col gap-3'),
                ],
                Array.map(items, item => itemCard(h, context, item)),
              ),
              addItemRow(h, context, section.id, name),
              Array.match(children, {
                onEmpty: () => h.empty,
                onNonEmpty: list =>
                  h.ul(
                    [
                      h.AriaLabel(`Subsections of ${name}`),
                      h.Class(
                        'flex flex-col gap-3 border-l-2 border-msf-ink pl-3',
                      ),
                    ],
                    Array.map(list, child =>
                      sectionCard(h, context, child, depth + 1),
                    ),
                  ),
              }),
              depth < MAX_SECTION_DEPTH
                ? row(h, [
                    smallButton(
                      h,
                      'Add subsection',
                      Message.ClickedAdd({
                        kind: 'subsection',
                        parentId: section.id,
                      }),
                      Option.some(`Add a subsection to ${name}`),
                    ),
                  ])
                : h.empty,
              confirmRemove(h, context, 'section', section.id, name),
              row(h, [
                ...(section.isConclusion
                  ? []
                  : [
                      ...moveButtons(
                        h,
                        `${kind.toLowerCase()} ${name}`,
                        send({
                          _tag: 'MoveSection',
                          id: section.id,
                          direction: 'up',
                        }),
                        send({
                          _tag: 'MoveSection',
                          id: section.id,
                          direction: 'down',
                        }),
                      ),
                      ...(section.parentId === null
                        ? []
                        : [
                            smallButton(
                              h,
                              'Move out one level',
                              send({
                                _tag: 'MoveSection',
                                id: section.id,
                                direction: 'out',
                              }),
                              Option.some(`Move ${name} out one level`),
                            ),
                          ]),
                      smallButton(
                        h,
                        'Nest under the one above',
                        send({
                          _tag: 'MoveSection',
                          id: section.id,
                          direction: 'in',
                        }),
                        Option.some(`Nest ${name} under the section above`),
                      ),
                    ]),
                smallButton(
                  h,
                  `Remove ${kind.toLowerCase()}`,
                  Message.AskedRemove({ kind: 'section', id: section.id }),
                  Option.some(`Remove ${kind.toLowerCase()} ${name}`),
                ),
              ]),
            ]
          : []),
      ]),
    ],
  )
}

const sectionsPanel = (h: H, context: Context): Html => {
  const roots = context.sectionsByParent.get(null) ?? []
  const body = Array.filter(roots, entry => !entry.isConclusion)
  const conclusion = Array.filter(roots, entry => entry.isConclusion)
  return panelOf(
    h,
    context,
    'panel:sections',
    'Sections',
    'The structure of the report. Sections nest as subsections; items are what the author fills in. The conclusion is the last section, written after the committee has decided.',
    [
      problemList(
        h,
        Array.filter(
          problemsAt(context, 'template'),
          entry => entry.target.field === 'sections',
        ),
      ),
      h.ul(
        [h.AriaLabel('Sections'), h.Class('flex flex-col gap-4')],
        Array.map(body, entry => sectionCard(h, context, entry, 1)),
      ),
      Array.match(conclusion, {
        onEmpty: () =>
          row(h, [
            smallButton(
              h,
              'Add a section',
              Message.ClickedAdd({ kind: 'section', parentId: '' }),
            ),
            smallButton(
              h,
              'Add a conclusion',
              Message.ClickedAdd({ kind: 'conclusion', parentId: '' }),
            ),
          ]),
        onNonEmpty: list =>
          h.div(
            [h.Class('flex flex-col gap-4')],
            [
              row(h, [
                smallButton(
                  h,
                  'Add a section',
                  Message.ClickedAdd({ kind: 'section', parentId: '' }),
                ),
              ]),
              h.ul(
                [h.AriaLabel('Conclusion'), h.Class('flex flex-col gap-4')],
                Array.map(list, entry => sectionCard(h, context, entry, 1)),
              ),
            ],
          ),
      }),
    ],
  )
}

// ---- Ending -------------------------------------------------------------------

const endingPanel = (h: H, context: Context): Html => {
  const { form } = context
  const ends = Array.filter(form.items, item => item.endOptionId !== '')
  const found = problemsAt(context, 'ending')
  return panelOf(
    h,
    context,
    'panel:ending',
    'Ending the report early (branching)',
    'A choice can end the report: the author is told the outcome, and the sections that are not marked below are left out. Mark a choice as ending in its options.',
    [
      h.p(
        [h.Class('text-base text-msf-ink')],
        [
          ends.length === 0
            ? 'No choice ends the report.'
            : `Ending choices: ${Array.map(ends, item => item.label || item.id).join(', ')}.`,
        ],
      ),
      area(
        h,
        'ending-outcome',
        'What the report says when it ends early',
        form.endingOutcomeText,
        value => send({ _tag: 'SetText', field: 'endingOutcomeText', value }),
      ),
      h.div(
        [h.Class('flex flex-col gap-2')],
        [
          h.p(
            [h.Class('text-base font-medium text-msf-ink')],
            ['Sections that stay in force after an early ending'],
          ),
          ...Array.map(form.sections, section =>
            checkboxField(
              h,
              `ending-keeps-${section.id}`,
              section.title === '' ? section.id : section.title,
              form.endingStaysInForce.includes(section.id),
              send({ _tag: 'ToggleStaysInForce', sectionId: section.id }),
            ),
          ),
        ],
      ),
      problemList(h, found),
    ],
  )
}

// ---- Cover and pages ---------------------------------------------------------------

const coverPanel = (h: H, context: Context): Html => {
  const { form } = context
  const items = Array.filter(form.items, item => item.type !== 'repeated')
  return panelOf(
    h,
    context,
    'panel:cover',
    'Cover page',
    'Lines of the cover. A line is made of parts: fixed text, a value the author filled in, or a value of the case.',
    [
      h.ul(
        [h.AriaLabel('Cover lines'), h.Class('flex flex-col gap-3')],
        Array.map(form.coverLines, (line, lineIndex) => {
          const parts = Array.filter(
            form.coverParts,
            part => part.lineIndex === lineIndex,
          )
          const found = problemsAt(context, 'cover', String(lineIndex))
          return h.keyed('li')(
            String(lineIndex),
            [
              h.Class('list-none'),
              h.DataAttribute('cover-line', String(lineIndex)),
            ],
            [
              card(h, [
                row(h, [
                  h.p(
                    [h.Class('pb-2 text-base font-medium text-msf-ink')],
                    [`Line ${lineIndex + 1}`],
                  ),
                  choice(
                    h,
                    `cover-${lineIndex}-emphasis`,
                    'Shown as',
                    line.emphasis,
                    [
                      { value: 'title', label: 'Title' },
                      { value: 'subtitle', label: 'Subtitle' },
                      { value: 'normal', label: 'Normal text' },
                    ],
                    value =>
                      send({
                        _tag: 'SetCoverEmphasis',
                        index: lineIndex,
                        value:
                          value === 'title'
                            ? 'title'
                            : value === 'subtitle'
                              ? 'subtitle'
                              : 'normal',
                      }),
                  ),
                ]),
                ...Array.map(parts, (part, partIndex) =>
                  row(h, [
                    part.kind === 'text'
                      ? input(h, {
                          id: `cover-${lineIndex}-${partIndex}-text`,
                          label: 'Text',
                          value: part.text,
                          onInput: value =>
                            send({
                              _tag: 'SetCoverPart',
                              lineIndex,
                              partIndex,
                              field: 'text',
                              value,
                            }),
                        })
                      : part.kind === 'item'
                        ? choice(
                            h,
                            `cover-${lineIndex}-${partIndex}-item`,
                            'What the author filled in',
                            part.itemId,
                            [
                              { value: '', label: 'Choose an item' },
                              ...Array.map(items, item => ({
                                value: item.id,
                                label: item.label || item.id,
                              })),
                            ],
                            value =>
                              send({
                                _tag: 'SetCoverPart',
                                lineIndex,
                                partIndex,
                                field: 'itemId',
                                value,
                              }),
                          )
                        : choice(
                            h,
                            `cover-${lineIndex}-${partIndex}-field`,
                            'Value of the case',
                            part.field === '' ? 'reference' : part.field,
                            [
                              { value: 'reference', label: 'Reference' },
                              { value: 'unit', label: 'Unit' },
                              { value: 'title', label: 'Title' },
                            ],
                            value =>
                              send({
                                _tag: 'SetCoverPart',
                                lineIndex,
                                partIndex,
                                field: 'field',
                                value,
                              }),
                          ),
                    smallButton(
                      h,
                      'Remove part',
                      send({ _tag: 'RemoveCoverPart', lineIndex, partIndex }),
                      Option.some(
                        `Remove part ${partIndex + 1} of cover line ${lineIndex + 1}`,
                      ),
                    ),
                  ]),
                ),
                problemList(h, found),
                row(h, [
                  smallButton(
                    h,
                    'Add text',
                    send({ _tag: 'AddCoverPart', lineIndex, kind: 'text' }),
                    Option.some(`Add text to cover line ${lineIndex + 1}`),
                  ),
                  smallButton(
                    h,
                    'Add an item value',
                    send({ _tag: 'AddCoverPart', lineIndex, kind: 'item' }),
                    Option.some(
                      `Add an item value to cover line ${lineIndex + 1}`,
                    ),
                  ),
                  smallButton(
                    h,
                    'Add a case value',
                    send({
                      _tag: 'AddCoverPart',
                      lineIndex,
                      kind: 'case_value',
                    }),
                    Option.some(
                      `Add a case value to cover line ${lineIndex + 1}`,
                    ),
                  ),
                  smallButton(
                    h,
                    'Remove line',
                    send({ _tag: 'RemoveCoverLine', index: lineIndex }),
                    Option.some(`Remove cover line ${lineIndex + 1}`),
                  ),
                ]),
              ]),
            ],
          )
        }),
      ),
      row(h, [
        smallButton(h, 'Add a cover line', send({ _tag: 'AddCoverLine' })),
      ]),
    ],
  )
}

const pagesPanel = (h: H, context: Context): Html => {
  const { form } = context
  const furniture = problemsAt(context, 'furniture')
  const template = problemsAt(context, 'template')
  return panelOf(
    h,
    context,
    'panel:pages',
    'Contents, page numbers, header and footer',
    'Header and footer text can use {page}, {pages}, {case} and {title}.',
    [
      row(h, [
        input(h, {
          id: 'template-contents-depth',
          label: 'Levels in the contents (empty: no contents)',
          type: 'number',
          narrow: true,
          value: form.contentsDepth === null ? '' : String(form.contentsDepth),
          onInput: value =>
            send({ _tag: 'SetContentsDepth', value: maybeIntOf(value) }),
        }),
        choice(
          h,
          'template-page-numbering',
          'Page numbers',
          form.pageNumbering,
          [
            { value: 'continuous', label: 'Continuous' },
            {
              value: 'restart_after_front_matter',
              label: 'Restart after the front matter',
            },
          ],
          value =>
            send({
              _tag: 'SetPageNumbering',
              value:
                value === 'restart_after_front_matter'
                  ? 'restart_after_front_matter'
                  : 'continuous',
            }),
        ),
      ]),
      problemList(
        h,
        Array.filter(
          template,
          entry =>
            entry.target.field === 'contentsDepth' ||
            entry.target.field === 'pageNumbering',
        ),
      ),
      input(h, {
        id: 'template-header',
        label: 'Header',
        value: form.header,
        onInput: value => send({ _tag: 'SetText', field: 'header', value }),
      }),
      input(h, {
        id: 'template-footer',
        label: 'Footer',
        value: form.footer,
        onInput: value => send({ _tag: 'SetText', field: 'footer', value }),
      }),
      input(h, {
        id: 'template-cover-header',
        label: 'Header of the cover',
        value: form.coverHeader,
        onInput: value =>
          send({ _tag: 'SetText', field: 'coverHeader', value }),
      }),
      input(h, {
        id: 'template-cover-footer',
        label: 'Footer of the cover',
        value: form.coverFooter,
        onInput: value =>
          send({ _tag: 'SetText', field: 'coverFooter', value }),
      }),
      problemList(h, furniture),
    ],
  )
}

// ---- Preview ------------------------------------------------------------------

type Counter = { position: number }

const previewSection = (
  h: H,
  template: Template,
  section: Section,
  depth: number,
  prefix: ReadonlyArray<string>,
  counter: Counter,
): Html => {
  const level = template.numbering[depth - 1]
  const isFront = depth === 1 && section.frontMatter
  let bare: string | undefined
  let number = ''
  if (section.numbered && !isFront && level !== undefined) {
    counter.position += 1
    bare = formatNumber(counter.position, level)
    number = `${[...prefix, bare].join('.')}${level.suffix} `
  }
  const next = bare === undefined ? prefix : [...prefix, bare]
  const childCounter: Counter = { position: 0 }
  const own: Section = { ...section, sections: [] }
  return h.div(
    [
      h.Class('flex min-w-0 flex-col gap-3'),
      h.DataAttribute('preview-section', section.id),
    ],
    [
      h.h3(
        [
          h.Class(
            depth === 1
              ? 'text-2xl font-black tracking-tight'
              : 'text-xl font-bold',
          ),
        ],
        [`${number}${section.title}`],
      ),
      section.repeat === undefined
        ? h.empty
        : h.p(
            [h.Class('text-base text-msf-grey')],
            [
              `Repeated: one for each entry, at least ${section.repeat.min}${
                section.repeat.max === undefined
                  ? ''
                  : ` and at most ${section.repeat.max}`
              }.`,
            ],
          ),
      section.requirement === 'required'
        ? h.empty
        : h.p(
            [h.Class('text-base text-msf-grey')],
            ['This section can be left out.'],
          ),
      section.instruction === undefined
        ? h.empty
        : h.p(
            [h.Class('text-base italic text-msf-grey')],
            [section.instruction],
          ),
      readOnlySection(h, own, undefined, {
        reportId: '',
        people: [],
        topSectionId: section.id,
      }),
      ...Array.map(section.sections, child =>
        previewSection(h, template, child, depth + 1, next, childCounter),
      ),
    ],
  )
}

const previewView = (h: H, model: Model): Html => {
  const built = templateOfForm(model.form)
  return Result.match(built, {
    onFailure: () =>
      h.section(
        [h.AriaLabel('Preview'), h.Class('flex flex-col gap-3')],
        [
          alertText(
            h,
            'The preview needs a template without problems. Go back to the form and fix what is marked.',
          ),
        ],
      ),
    onSuccess: template => {
      const counter: Counter = { position: 0 }
      const sections =
        template.conclusion === undefined
          ? template.sections
          : [...template.sections, template.conclusion]
      return h.section(
        [
          h.AriaLabel('Preview of a new report'),
          h.Class('flex flex-col gap-8 border-t-2 border-msf-ink pt-5'),
        ],
        [
          h.h2(
            [h.Class('text-2xl font-black tracking-tight')],
            ['Preview of a new report'],
          ),
          h.p(
            [h.Class('text-base text-msf-grey')],
            [
              `A new report from this template starts empty. ${template.caseReferenceLabel}: shown from the case. Reading only: nothing here is saved.`,
            ],
          ),
          ...Array.map(sections, section =>
            previewSection(h, template, section, 1, [], counter),
          ),
        ],
      )
    },
  })
}

// ---- Publishing ----------------------------------------------------------------

const changeText = (change: {
  change: string
  target: string
  label: string
}): string => `${change.change} ${change.target}: ${change.label}`

const publishPanel = (h: H, model: Model): Html =>
  PublishState.match(model.publish, {
    Idle: () => h.empty,
    Preparing: () =>
      statusText(
        h,
        'Saving the draft and comparing it with the previous version.',
      ),
    Reviewing: ({ changes }) =>
      h.section(
        [
          h.Role('region'),
          h.AriaLabel('Publish this version'),
          h.Class('flex flex-col gap-3 border-2 border-msf-ink p-4'),
        ],
        [
          h.h2(
            [h.Class('text-2xl font-black tracking-tight')],
            [`Publish version ${model.version}?`],
          ),
          h.p(
            [h.Class('text-base text-msf-ink')],
            [
              'Once published a version never changes. New reports use it from now on; reports that already exist keep the version they started with.',
            ],
          ),
          Array.match(changes, {
            onEmpty: () =>
              h.p(
                [h.Class('text-base text-msf-grey')],
                ['Nothing differs from the previous version.'],
              ),
            onNonEmpty: list =>
              h.ul(
                [
                  h.AriaLabel('Changes since the previous version'),
                  h.Class(
                    'flex max-h-72 flex-col gap-1 overflow-y-auto border border-msf-line p-3',
                  ),
                ],
                Array.map(list, change =>
                  h.li(
                    [
                      h.Class('text-base text-msf-ink'),
                      h.DataAttribute('change', change.change),
                    ],
                    [changeText(change)],
                  ),
                ),
              ),
          }),
          row(h, [
            smallButton(
              h,
              `Publish version ${model.version}`,
              Message.ClickedConfirmPublish(),
            ),
            smallButton(h, 'Back to editing', Message.ClickedBackToEditing()),
          ]),
        ],
      ),
    Publishing: () => statusText(h, 'Publishing.'),
    Published: ({ changes }) =>
      h.div(
        [
          h.Role('status'),
          h.Class('flex flex-col gap-2 border-2 border-msf-ink p-4'),
        ],
        [
          h.p(
            [h.Class('text-lg font-bold text-msf-black')],
            [`Version ${model.version} is published.`],
          ),
          h.p(
            [h.Class('text-base text-msf-ink')],
            [
              `${changes.length} ${changes.length === 1 ? 'change' : 'changes'} since the previous version. New reports use this version.`,
            ],
          ),
        ],
      ),
    Failed: ({ failure }) => alertText(h, failureText(failure)),
  })

// ---- Page ---------------------------------------------------------------------

const saveText = (state: SaveState): string =>
  SaveState.match(state, {
    Clean: () => '',
    Dirty: () => 'Unsaved changes.',
    Saving: () => 'Saving.',
    Saved: () => 'Draft saved.',
    Failed: ({ failure }) => failureText(failure),
    Stale: () =>
      'This draft was changed by someone else since you opened it, so your changes are not saved. Reload to see their version; your changes here are lost.',
  })

const summaryOf = (record: { state: string; version: number }): string =>
  record.state === 'draft'
    ? `Draft of version ${record.version}`
    : record.state === 'published'
      ? `Published, version ${record.version}. It never changes.`
      : `Retired, version ${record.version}. It never changes.`

const backLink = (h: H): Html =>
  h.a(
    [
      h.Href(pathOf(AppRoute.Templates())),
      h.Class(clsx('self-start text-base text-msf-ink underline', focusRing)),
    ],
    ['Back to the templates'],
  )

const loaded = (h: H, model: Model): Html => {
  const record = Option.getOrUndefined(model.maybeRecord)
  const draft = isDraft(model)
  const context = contextOf(model)
  const unfixed = context.problems.length
  const busy =
    SaveState.guards.Saving(model.save) ||
    PublishState.guards.Preparing(model.publish) ||
    PublishState.guards.Publishing(model.publish)
  const previewing = model.mode === 'preview'
  return h.section(
    [
      h.AriaLabel('Template editor'),
      h.Class('flex max-w-5xl flex-col gap-8 pb-20 pt-8 md:pt-12'),
    ],
    [
      backLink(h),
      h.div(
        [h.Class('flex flex-col gap-2')],
        [
          h.h1(
            [
              h.Id('page-heading'),
              h.Class(
                'text-balance text-4xl font-black leading-[1.05] tracking-[-0.025em] text-msf-black',
              ),
            ],
            [draft ? `Edit ${model.form.name}` : model.form.name],
          ),
          record === undefined
            ? h.empty
            : h.p([h.Class('text-lg text-msf-ink')], [summaryOf(record)]),
        ],
      ),
      draft
        ? h.div(
            [
              h.Class(
                'sticky top-0 z-10 flex flex-col gap-2 border-b border-msf-line bg-white py-3',
              ),
              h.DataAttribute('editor-bar', 'draft'),
            ],
            [
              row(h, [
                smallButton(
                  h,
                  busy ? 'Working.' : 'Save draft',
                  Message.ClickedSave(),
                ),
                SaveState.guards.Stale(model.save)
                  ? smallButton(
                      h,
                      'Reload the draft',
                      Message.ClickedReload(),
                    )
                  : h.empty,
                previewing
                  ? smallButton(
                      h,
                      'Back to editing',
                      Message.ClickedMode({ mode: 'edit' }),
                    )
                  : smallButton(
                      h,
                      'Preview',
                      Message.ClickedMode({ mode: 'preview' }),
                    ),
                smallButton(
                  h,
                  `Publish version ${model.version}`,
                  Message.ClickedPublish(),
                ),
              ]),
              h.p(
                [
                  h.Role('status'),
                  h.Class('text-base font-medium text-msf-ink'),
                ],
                [saveText(model.save)],
              ),
              unfixed > 0
                ? h.p(
                    [
                      h.Class('text-base font-medium text-msf-alert'),
                      h.DataAttribute('problem-count', String(unfixed)),
                    ],
                    [
                      `${unfixed} ${unfixed === 1 ? 'thing needs' : 'things need'} fixing before this can be published.`,
                    ],
                  )
                : h.p(
                    [h.Class('text-base text-msf-grey')],
                    ['Nothing is marked: this can be published.'],
                  ),
              Option.match(model.maybeNotice, {
                onNone: () => h.empty,
                onSome: notice => alertText(h, notice),
              }),
            ],
          )
        : h.div(
            [h.Class('flex flex-col gap-3')],
            [
              row(h, [
                smallButton(
                  h,
                  'Start a new version',
                  Message.ClickedNewVersion(),
                ),
                previewing
                  ? smallButton(
                      h,
                      'Show the structure',
                      Message.ClickedMode({ mode: 'edit' }),
                    )
                  : smallButton(
                      h,
                      'Preview',
                      Message.ClickedMode({ mode: 'preview' }),
                    ),
              ]),
              Option.match(model.maybeNewDraft, {
                onNone: () => h.empty,
                onSome: version =>
                  h.a(
                    [
                      h.Href(
                        pathOf(
                          AppRoute.TemplateEditor({
                            templateId: model.templateId,
                            version,
                          }),
                        ),
                      ),
                      h.Class(
                        clsx(
                          'self-start text-lg text-msf-ink underline',
                          focusRing,
                        ),
                      ),
                    ],
                    [`Open the draft of version ${version}`],
                  ),
              }),
              Option.match(model.maybeNotice, {
                onNone: () => h.empty,
                onSome: notice => alertText(h, notice),
              }),
            ],
          ),
      publishPanel(h, model),
      previewing
        ? previewView(h, model)
        : draft
          ? h.div(
              [h.Class('flex flex-col gap-10')],
              [
                unfixed > 0
                  ? h.section(
                      [
                        h.AriaLabel('Problems'),
                        h.Class(
                          'flex flex-col gap-2 border border-msf-alert p-4',
                        ),
                      ],
                      [
                        h.h2(
                          [h.Class('text-xl font-bold text-msf-alert')],
                          ['To fix'],
                        ),
                        h.ul(
                          [h.Class('flex flex-col gap-1')],
                          Array.map(context.problems, entry =>
                            h.li(
                              [h.Class('text-base text-msf-ink')],
                              [entry.problem.message],
                            ),
                          ),
                        ),
                      ],
                    )
                  : h.empty,
                aboutPanel(h, context),
                rolesPanel(h, context),
                numberingPanel(h, context),
                sectionsPanel(h, context),
                endingPanel(h, context),
                coverPanel(h, context),
                pagesPanel(h, context),
              ],
            )
          : h.p(
              [h.Class('text-lg text-msf-ink')],
              [
                'This version is published, so it cannot be edited. Preview it, or start a new version to change it.',
              ],
            ),
    ],
  )
}

export const view = Submodel.defineView<Model, Message>((model, h) =>
  LoadState.match(model.load, {
    Loading: () => h.section([h.Class('pt-10')], [loadingText(h, 'Loading.')]),
    Failed: ({ failure }) =>
      h.section(
        [h.Class('flex flex-col gap-4 pt-10')],
        [
          backLink(h),
          alertText(h, failureText(failure)),
          smallButton(h, 'Try again', Message.ClickedRetryLoad()),
        ],
      ),
    Loaded: () => loaded(h, model),
  }),
)

// SUBSCRIPTION

// NOTE: Closing the tab with a draft that is not saved asks first, as the
// report screen does.
export const subscriptions = Subscription.make<Model, Message>()(entry => ({
  unsavedTemplateEdits: entry(
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
}))
