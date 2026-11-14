import {
  click,
  given,
  role,
  scene,
  expect as sceneExpect,
  selector,
} from 'foldkit/scene'
import { describe, expect, test } from 'vitest'

import { INTAKE_TEMPLATE } from '@case-desk/domain'

import { update } from './main'
import * as TemplateEditor from './quoroom/templateEditor'
import {
  BLANK_RECORD,
  editorMessage,
  openEditor,
  recordOf,
} from './templates.fixtures'
import { view } from './view'

// NOTE: The long editor folds. Closed by default except the sections
// panel; opening is remembered; a problem shows its panel and its section
// open; a section just added is open.

const intake = recordOf(INTAKE_TEMPLATE)
const send = (
  model: ReturnType<typeof openEditor>,
  ...messages: ReadonlyArray<TemplateEditor.Message>
) =>
  messages.reduce(
    (current, next) => update(current, editorMessage(next)).model,
    model,
  )

describe('folding the template editor', () => {
  test('only the sections panel is open and no section shows its fields', () => {
    scene(
      { update, view },
      given(openEditor(intake)),
      sceneExpect(
        selector(
          '[data-panel="panel:sections"] [data-toggle][aria-expanded="true"]',
        ),
      ).toExist(),
      sceneExpect(
        selector(
          '[data-panel="panel:roles"] [data-toggle][aria-expanded="false"]',
        ),
      ).toExist(),
      sceneExpect(selector('[data-panel="panel:about"] input')).toBeAbsent(),
      sceneExpect(selector('[data-section-id] input')).toBeAbsent(),
      sceneExpect(selector('[data-section-id]')).toExist(),
    )
  })

  test('a panel opened by a click stays open, and closes with another', () => {
    const opened = send(
      openEditor(intake),
      TemplateEditor.Message.ToggledOpen({ key: 'panel:about' }),
    )
    expect(opened.templateEditor.expanded).toContain('panel:about')
    scene(
      { update, view },
      given(opened),
      sceneExpect(selector('[data-panel="panel:about"] input')).toExist(),
      click(role('button', { name: /^▾ About this template/ })),
      sceneExpect(selector('[data-panel="panel:about"] input')).toBeAbsent(),
    )
  })

  test('a section is opened by its button', () => {
    const first = INTAKE_TEMPLATE.sections[0]?.id ?? ''
    scene(
      { update, view },
      given(openEditor(intake)),
      click(selector(`[data-section-id="${first}"] [data-toggle]`)),
      sceneExpect(selector(`[data-section-id="${first}"] input`)).toExist(),
    )
  })

  test('a problem opens its panel and its section, and they cannot be closed meanwhile', () => {
    const base = openEditor(BLANK_RECORD)
    const added = send(
      base,
      TemplateEditor.Message.ClickedAdd({ kind: 'section', parentId: '' }),
    )
    const newId = added.templateEditor.form.sections.at(-1)?.id ?? ''
    const untitled = send(
      added,
      TemplateEditor.Message.Edited({
        edit: { _tag: 'SetSectionText', id: newId, field: 'title', value: '' },
      }),
    )
    expect(untitled.templateEditor.expanded).toContain(`section:${newId}`)
    const closedByHand = send({
      ...untitled,
      templateEditor: { ...untitled.templateEditor, expanded: [] },
    })
    scene(
      { update, view },
      given(closedByHand),
      sceneExpect(selector(`[data-section-id="${newId}"] input`)).toExist(),
      sceneExpect(
        selector('[data-panel="panel:sections"] [data-toggle][disabled]'),
      ).toExist(),
    )
  })

  test('adding an item to a closed section opens that section', () => {
    const base = openEditor(intake)
    const first = INTAKE_TEMPLATE.sections[0]?.id ?? ''
    const added = send(
      base,
      TemplateEditor.Message.ClickedAdd({ kind: 'item', parentId: first }),
    )
    expect(added.templateEditor.expanded).toContain(`section:${first}`)
  })

  test('renaming a section keeps it open', () => {
    const first = INTAKE_TEMPLATE.sections[0]?.id ?? ''
    const opened = send(
      openEditor(intake),
      TemplateEditor.Message.ToggledOpen({ key: `section:${first}` }),
    )
    const renamed = send(
      opened,
      TemplateEditor.Message.Edited({
        edit: {
          _tag: 'Rename',
          scope: 'section',
          id: first,
          newId: 'renamed-first',
        },
      }),
    )
    expect(renamed.templateEditor.expanded).toContain('section:renamed-first')
    expect(renamed.templateEditor.expanded).not.toContain(`section:${first}`)
  })
})
