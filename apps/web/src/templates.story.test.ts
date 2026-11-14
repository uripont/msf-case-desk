import { Option, Result } from 'effect'
import { describe, expect, test } from 'vitest'

import {
  INTAKE_TEMPLATE,
  formProblems,
  templateOfForm,
} from '@case-desk/domain'
import { PANEL_EDITS } from '@case-desk/domain/testing/template-edits'
import { PANEL_TEMPLATE } from '@case-desk/domain/testing/templates'

import { Message, OpenDialogFocus, update } from './main'
import { clickedLinkTo } from './fixtures'
import * as TemplateEditor from './quoroom/templateEditor'
import * as Templates from './quoroom/templates'
import {
  BLANK_RECORD,
  SUMMARIES,
  editorMessage,
  openEditor,
  recordOf,
  scopeOf,
} from './templates.fixtures'

// NOTE: Stage 9b and 9c, as a person would drive them: the invented panel
// template built from a blank draft in the editor, one edit at a time; adding
// rows with generated IDs; saving; publishing only after the differences have
// been shown. Checked on the Model and the Commands.

const idle = (model: ReturnType<typeof openEditor>): ReturnType<typeof update> => ({
  model,
  commands: [],
})

const send = (
  model: ReturnType<typeof openEditor>,
  ...messages: ReadonlyArray<TemplateEditor.Message>
) =>
  messages.reduce(
    (current, next) => update(current.model, editorMessage(next)),
    idle(model),
  )

const names = (step: ReturnType<typeof update>) =>
  (step.commands ?? []).map(command => command.name)

const built = (model: ReturnType<typeof openEditor>) => {
  const result = templateOfForm(model.templateEditor.form)
  if (Result.isFailure(result)) throw new Error(JSON.stringify(result.failure))
  return result.success
}

describe('building a template in the editor', () => {
  test('the invented panel template built from a blank draft equals the domain test template', () => {
    const start = openEditor(BLANK_RECORD)
    const done = send(
      start,
      ...PANEL_EDITS.map(edit => TemplateEditor.Message.Edited({ edit })),
    )
    expect(built(done.model)).toEqual(PANEL_TEMPLATE)
    expect(SaveStateOf(done.model)).toBe('Dirty')
  })

  test('rows added from the buttons get IDs no row has, one after another', () => {
    const start = openEditor(BLANK_RECORD)
    const added = send(
      start,
      TemplateEditor.Message.ClickedAdd({ kind: 'section', parentId: '' }),
      TemplateEditor.Message.ClickedAdd({ kind: 'section', parentId: '' }),
      TemplateEditor.Message.ClickedAdd({ kind: 'subsection', parentId: 'section-1' }),
      TemplateEditor.Message.SelectedNewItemType({ value: 'select' }),
      TemplateEditor.Message.ClickedAdd({ kind: 'item', parentId: 'section-1' }),
      TemplateEditor.Message.ClickedAdd({ kind: 'option', parentId: 'item-1' }),
      TemplateEditor.Message.ClickedAdd({ kind: 'reviewing_role', parentId: '' }),
    )
    const form = added.model.templateEditor.form
    expect(form.sections.map(row => row.id)).toEqual(['summary', 'section-1', 'section-2', 'section-3'])
    expect(form.sections.find(row => row.id === 'section-3')?.parentId).toBe('section-1')
    expect(form.items.find(row => row.id === 'item-4')?.type).toBe('select')
    expect(form.options.map(row => row.id)).toEqual(['option-5'])
    expect(form.roles.at(-1)?.id).toBe('role-6')
  })

  test('a section is removed only after it is confirmed', () => {
    const start = openEditor(BLANK_RECORD)
    const asked = send(start, TemplateEditor.Message.AskedRemove({ kind: 'section', id: 'summary' }))
    expect(asked.model.templateEditor.form.sections.length).toBe(1)
    const cancelled = send(asked.model, TemplateEditor.Message.CancelledRemove())
    expect(cancelled.model.templateEditor.form.sections.length).toBe(1)
    const confirmed = send(
      asked.model,
      TemplateEditor.Message.ConfirmedRemove(),
    )
    expect(confirmed.model.templateEditor.form.sections.length).toBe(0)
    expect(confirmed.model.templateEditor.form.items.length).toBe(0)
  })

  test('a published version cannot be edited', () => {
    const published = openEditor(recordOf(INTAKE_TEMPLATE, 'published'))
    const step = send(
      published,
      TemplateEditor.Message.Edited({ edit: { _tag: 'SetText', field: 'name', value: 'Changed' } }),
    )
    expect(step.model.templateEditor.form.name).toBe(INTAKE_TEMPLATE.name)
    expect(names(send(published, TemplateEditor.Message.ClickedSave()))).toEqual([])
  })
})

const SaveStateOf = (model: ReturnType<typeof openEditor>): string =>
  model.templateEditor.save._tag

describe('saving and publishing', () => {
  const edited = () =>
    send(
      openEditor(BLANK_RECORD),
      TemplateEditor.Message.Edited({
        edit: { _tag: 'SetText', field: 'name', value: 'A new name' },
      }),
    ).model

  test('saving sends the draft and says saved only when no edit came meanwhile', () => {
    const saving = send(edited(), TemplateEditor.Message.ClickedSave())
    expect(names(saving)).toEqual([TemplateEditor.SaveTemplateDraft.name])
    expect(SaveStateOf(saving.model)).toBe('Saving')
    const scope = scopeOf(BLANK_RECORD)
    const saved = send(
      saving.model,
      TemplateEditor.Message.SucceededSave({ scope, record: BLANK_RECORD, edits: 1 }),
    )
    expect(SaveStateOf(saved.model)).toBe('Saved')
    const meanwhile = send(
      saving.model,
      TemplateEditor.Message.Edited({ edit: { _tag: 'SetText', field: 'name', value: 'Another' } }),
      TemplateEditor.Message.SucceededSave({ scope, record: BLANK_RECORD, edits: 1 }),
    )
    expect(SaveStateOf(meanwhile.model)).toBe('Dirty')
  })

  test('a draft that does not fit the schema is not sent', () => {
    const broken = send(
      edited(),
      TemplateEditor.Message.Edited({
        edit: { _tag: 'SetSectionText', id: 'summary', field: 'title', value: '   ' },
      }),
      TemplateEditor.Message.ClickedSave(),
    )
    expect(names(broken)).toEqual([])
    expect(Option.isSome(broken.model.templateEditor.maybeNotice)).toBe(true)
  })

  test('a template with problems is not published, and one without shows the differences first', () => {
    const problem = send(
      edited(),
      TemplateEditor.Message.Edited({
        edit: { _tag: 'SetApproval', id: 'reviewers', kind: 'at_least', count: 0 },
      }),
    )
    expect(formProblems(problem.model.templateEditor.form).length).toBeGreaterThan(0)
    const refused = send(problem.model, TemplateEditor.Message.ClickedPublish())
    expect(names(refused)).toEqual([])
    expect(refused.model.templateEditor.publish._tag).toBe('Idle')

    const asked = send(edited(), TemplateEditor.Message.ClickedPublish())
    expect(names(asked)).toEqual([TemplateEditor.PrepareTemplateDiff.name])
    const scope = scopeOf(BLANK_RECORD)
    const changes = [{ change: 'changed' as const, target: 'setting' as const, label: 'name' }]
    const reviewing = send(
      asked.model,
      TemplateEditor.Message.SucceededPrepare({ scope, record: BLANK_RECORD, edits: 1, changes }),
    )
    expect(reviewing.model.templateEditor.publish._tag).toBe('Reviewing')
    expect(names(reviewing)).toEqual([])
    const confirmed = send(reviewing.model, TemplateEditor.Message.ClickedConfirmPublish())
    expect(names(confirmed)).toEqual([TemplateEditor.PublishTemplateVersion.name])
    const published = send(
      confirmed.model,
      TemplateEditor.Message.SucceededPublish({
        scope,
        record: recordOf(BLANK_RECORD.template, 'published'),
        changes,
      }),
    )
    expect(published.model.templateEditor.publish._tag).toBe('Published')
    expect(TemplateEditor.isDraft(published.model.templateEditor)).toBe(false)
  })

  test('an edit while the differences are shown takes the confirmation back', () => {
    const asked = send(edited(), TemplateEditor.Message.ClickedPublish())
    const reviewing = send(
      asked.model,
      TemplateEditor.Message.SucceededPrepare({
        scope: scopeOf(BLANK_RECORD),
        record: BLANK_RECORD,
        edits: 1,
        changes: [],
      }),
    )
    const edit = send(
      reviewing.model,
      TemplateEditor.Message.Edited({ edit: { _tag: 'SetText', field: 'name', value: 'Third' } }),
    )
    expect(edit.model.templateEditor.publish._tag).toBe('Idle')
    expect(names(send(edit.model, TemplateEditor.Message.ClickedConfirmPublish()))).toEqual([])
  })

  test('an answer for a template left behind is dropped', () => {
    const stale = send(
      openEditor(BLANK_RECORD),
      TemplateEditor.Message.SucceededSave({
        scope: { ...scopeOf(BLANK_RECORD), generation: 99 },
        record: recordOf({ ...BLANK_RECORD.template, name: 'Elsewhere' }),
        edits: 0,
      }),
    )
    expect(stale.model.templateEditor.maybeRecord).toEqual(Option.some(BLANK_RECORD))
  })
})

describe('the template list', () => {
  test('says what state a template is in', () => {
    expect(SUMMARIES.map(Templates.stateText)).toEqual([
      'Published, version 1',
      'Not published yet. Draft of version 1 in progress',
      'Retired, last version 2',
    ])
  })

  test('copying asks for a name, then copies the published version', () => {
    const list = openList()
    const noName = update(list, Message.GotTemplatesMessage({ message: Templates.Message.SubmittedCopy() }))
    expect(names(noName)).toEqual([])
    const named = [
      Templates.Message.UpdatedCopyName({ value: 'My copy' }),
      Templates.Message.SubmittedCopy(),
    ].reduce(
      (current, next) => update(current.model, Message.GotTemplatesMessage({ message: next })),
      idle(list),
    )
    expect(names(named)).toEqual([Templates.CreateTemplateDraft.name])
  })
})

import { listModel } from './templates.fixtures'
const openList = () => listModel

describe('leaving the template editor with unsaved edits', () => {
  const dirty = () =>
    send(
      openEditor(BLANK_RECORD),
      TemplateEditor.Message.Edited({
        edit: { _tag: 'SetText', field: 'name', value: 'A new name' },
      }),
    ).model

  test('a link to another page asks first and keeps the draft', () => {
    const asked = update(dirty(), clickedLinkTo('/templates'))
    expect(Option.isSome(asked.model.maybeLeaving)).toBe(true)
    expect(asked.model.route._tag).toBe('TemplateEditor')
    expect(asked.model.templateEditor.form.name).toBe('A new name')
  })

  test('staying keeps the edits; leaving without saving gives them up', () => {
    const asked = update(dirty(), clickedLinkTo('/templates'))
    const stayed = update(asked.model, Message.ClickedStayOnReport())
    expect(Option.isNone(stayed.model.maybeLeaving)).toBe(true)
    expect(TemplateEditor.hasUnsavedEdits(stayed.model.templateEditor)).toBe(true)
    const left = update(asked.model, Message.ClickedLeaveReportUnsaved())
    expect(left.model.route._tag).toBe('Templates')
    expect(TemplateEditor.hasUnsavedEdits(left.model.templateEditor)).toBe(false)
  })

  test('waiting saves the draft and leaves by itself when it is saved', () => {
    const asked = update(dirty(), clickedLinkTo('/templates'))
    const waiting = update(asked.model, Message.ClickedWaitToLeaveReport())
    expect(names(waiting)).toEqual([TemplateEditor.SaveTemplateDraft.name])
    expect(waiting.model.route._tag).toBe('TemplateEditor')
    const done = update(
      waiting.model,
      editorMessage(
        TemplateEditor.Message.SucceededSave({
          scope: scopeOf(BLANK_RECORD),
          record: { ...BLANK_RECORD, draftRevision: 1 },
          edits: 1,
        }),
      ),
    )
    expect(done.model.route._tag).toBe('Templates')
    expect(Option.isNone(done.model.maybeLeaving)).toBe(true)
  })

  test('a clean draft is left without asking', () => {
    const left = update(openEditor(BLANK_RECORD), clickedLinkTo('/templates'))
    expect(Option.isNone(left.model.maybeLeaving)).toBe(true)
    expect(left.model.route._tag).toBe('Templates')
  })

  test('the tab warning is on while the draft has unsaved edits', () => {
    expect(TemplateEditor.hasUnsavedEdits(dirty().templateEditor)).toBe(true)
    expect(TemplateEditor.hasUnsavedEdits(openEditor(BLANK_RECORD).templateEditor)).toBe(false)
  })
})

describe('a draft changed by someone else', () => {
  const dirtyModel = () =>
    send(
      openEditor(BLANK_RECORD),
      TemplateEditor.Message.Edited({
        edit: { _tag: 'SetText', field: 'name', value: 'A new name' },
      }),
    ).model

  test('the save carries the draft revision the editor read', () => {
    const saving = send(dirtyModel(), TemplateEditor.Message.ClickedSave())
    const command = (saving.commands ?? [])[0]
    expect(command?.args).toMatchObject({ draftRevision: 0 })
  })

  test('a refused save says so and offers a reload that fetches the current draft', () => {
    const saving = send(dirtyModel(), TemplateEditor.Message.ClickedSave())
    const failed = send(
      saving.model,
      TemplateEditor.Message.FailedSave({
        scope: scopeOf(BLANK_RECORD),
        failure: { _tag: 'Unavailable' },
        isStale: true,
      }),
    )
    expect(SaveStateOf(failed.model)).toBe('Stale')
    expect(TemplateEditor.hasUnsavedEdits(failed.model.templateEditor)).toBe(true)
    const reload = send(failed.model, TemplateEditor.Message.ClickedReload())
    expect(names(reload)).toEqual([TemplateEditor.LoadTemplateVersion.name])
    expect(SaveStateOf(reload.model)).toBe('Clean')
  })

  test('publishing names the revision the differences were shown for', () => {
    const asked = send(dirtyModel(), TemplateEditor.Message.ClickedPublish())
    const reviewing = send(
      asked.model,
      TemplateEditor.Message.SucceededPrepare({
        scope: scopeOf(BLANK_RECORD),
        record: { ...BLANK_RECORD, draftRevision: 4 },
        edits: 1,
        changes: [],
      }),
    )
    const confirmed = send(reviewing.model, TemplateEditor.Message.ClickedConfirmPublish())
    expect((confirmed.commands ?? [])[0]?.args).toMatchObject({ draftRevision: 4 })
  })

  test('a refused publish goes back to editing and asks for a reload', () => {
    const asked = send(dirtyModel(), TemplateEditor.Message.ClickedPublish())
    const failed = send(
      asked.model,
      TemplateEditor.Message.FailedPublish({
        scope: scopeOf(BLANK_RECORD),
        failure: { _tag: 'Unavailable' },
        isStale: true,
      }),
    )
    expect(failed.model.templateEditor.publish._tag).toBe('Idle')
    expect(SaveStateOf(failed.model)).toBe('Stale')
  })
})

describe('the template list pages, restores and discards', () => {
  const list = () => listModel

  test('more templates are asked for from the next offset and appended', () => {
    const first = update(
      list(),
      Message.GotTemplatesMessage({
        message: Templates.loadedTemplates(SUMMARIES.slice(0, 2), Option.some(2)),
      }),
    )
    expect(Option.isSome(first.model.templates.maybeNext)).toBe(true)
    const more = update(first.model, Message.GotTemplatesMessage({ message: Templates.Message.ClickedLoadMore() }))
    expect((more.commands ?? [])[0]?.args).toMatchObject({ offset: 2 })
    const done = update(
      more.model,
      Message.GotTemplatesMessage({
        message: Templates.Message.SucceededLoadTemplates({
          templates: SUMMARIES.slice(2),
          offset: 2,
          maybeNext: Option.none(),
        }),
      }),
    )
    expect(done.model.templates.templates.map(entry => entry.id)).toEqual(SUMMARIES.map(entry => entry.id))
    expect(Option.isNone(done.model.templates.maybeNext)).toBe(true)
  })

  test('a retired template can be restored; a draft is discarded only after a confirmation', () => {
    const restore = update(list(), Message.GotTemplatesMessage({ message: Templates.Message.ClickedRestore({ templateId: 'tpl-old' }) }))
    expect(names(restore)).toEqual([Templates.RestoreTemplate.name])
    const asked = update(list(), Message.GotTemplatesMessage({ message: Templates.Message.AskedDiscard({ templateId: 'tpl-draft' }) }))
    expect(names(asked)).toEqual([OpenDialogFocus.name])
    const confirmed = update(
      asked.model,
      Message.GotTemplatesMessage({ message: Templates.Message.ConfirmedDiscard({ templateId: 'tpl-draft', version: 1 }) }),
    )
    expect(names(confirmed)).toEqual([Templates.DiscardTemplateDraft.name])
  })
})
