import {
  Command,
  change,
  click,
  expect,
  given,
  role,
  scene,
  text,
  type,
} from 'foldkit/scene'
import { describe, test } from 'vitest'

import { CaseId } from '@case-desk/domain'

import { loadedModel } from './fixtures'
import { CreateCase, FocusElement, Message, update } from './main'
import { view } from './view'

describe('case entry scene', () => {
  test('the form previews the priority as it is filled in', () => {
    scene(
      { update, view },
      given(loadedModel),
      click(role('button', { name: 'New case' })),
      Command.resolve(FocusElement, Message.CompletedFocusElement()),
      expect(role('heading', { name: 'New case' })).toExist(),
      expect(role('complementary', { name: 'Priority preview' })).toContainText(
        'standard',
      ),
      click(role('checkbox', { name: 'Retaliation' })),
      expect(role('complementary', { name: 'Priority preview' })).toContainText(
        'urgent, fast-track',
      ),
    )
  })

  test('saving without a summary points at the field', () => {
    scene(
      { update, view },
      given(loadedModel),
      click(role('button', { name: 'New case' })),
      Command.resolve(FocusElement, Message.CompletedFocusElement()),
      click(role('button', { name: 'Save case' })),
      Command.resolve(FocusElement, Message.CompletedFocusElement()),
      expect(role('textbox', { name: 'Summary' })).toHaveAttr(
        'aria-invalid',
        'true',
      ),
      expect(text('Write a short summary', { exact: false })).toExist(),
    )
  })

  test('a saved case appears on the desk', () => {
    scene(
      { update, view },
      given(loadedModel),
      click(role('button', { name: 'New case' })),
      Command.resolve(FocusElement, Message.CompletedFocusElement()),
      type(role('textbox', { name: 'Summary' }), 'Synthetic scene case.'),
      change(role('combobox', { name: 'Operational centre' }), 'OCA'),
      click(role('button', { name: 'Save case' })),
      Command.resolve(
        CreateCase,
        Message.SucceededCreateCase({
          created: {
            id: CaseId.make('CD-SCENE001'),
            summary: 'Synthetic scene case.',
            centre: 'OCA',
            receivedAt: loadedModel.now,
            scope: 'Individual',
            risk: 'Low',
            urgency: 'Routine',
            fastTrackSignals: [],
            channel: 'IntegrityLine',
            details: '',
            location: '',
            reference: '',
            enteredAt: loadedModel.now,
            enteredByName: 'Synthetic Tester',
            schemaVersion: 1,
          },
        }),
      ),
      Command.resolve(FocusElement, Message.CompletedFocusElement()),
      expect(role('heading', { name: 'Synthetic scene case.' })).toExist(),
    )
  })
})
