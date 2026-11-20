import { expect, given, role, scene, text } from 'foldkit/scene'
import { describe, test } from 'vitest'

import { clickedLinkTo } from './fixtures'
import { update } from './main'
import * as TemplateEditor from './quoroom/templateEditor'
import {
  BLANK_RECORD,
  editorMessage,
  openEditor,
} from './templates.fixtures'
import { view } from './view'

// NOTE: With invented data: a template draft with an edit that is not saved,
// and a link to another page. The app asks before it leaves.

const editedTemplate = () =>
  editorMessage(
    TemplateEditor.Message.Edited({
      edit: { _tag: 'SetText', field: 'name', value: 'A new name' },
    }),
  )

const askingToLeave = () =>
  [editedTemplate(), clickedLinkTo('/templates')].reduce(
    (model, message) => update(model, message).model,
    openEditor(BLANK_RECORD),
  )

describe('leaving the template editor with unsaved edits', () => {
  test('the leave dialog is shown and the draft is kept', () => {
    scene(
      { update, view },
      given(askingToLeave()),
      expect(role('alertdialog', { name: 'Leave the template?' })).toExist(),
      expect(
        text('This template has changes that are not saved', { exact: false }),
      ).toExist(),
      expect(role('button', { name: 'Stay on this template' })).toExist(),
    )
  })
})
