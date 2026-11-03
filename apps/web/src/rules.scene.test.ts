import { click, expect, given, role, scene, text, type } from 'foldkit/scene'
import { describe, test } from 'vitest'

import { loadedModel } from './fixtures'
import { update } from './main'
import { view } from './view'

describe('rules editor scene', () => {
  test('editing a threshold previews the new groups', () => {
    scene(
      { update, view },
      given(loadedModel),
      click(role('button', { name: 'Rules' })),
      expect(role('heading', { name: 'Triage rules' })).toExist(),
      click(role('button', { name: 'OCG' })),
      expect(text('OCG uses the default rules', { exact: false })).toExist(),
      click(role('button', { name: 'Default' })),
      type(role('spinbutton', { name: 'Urgent from' }), '2'),
      type(role('spinbutton', { name: 'Medium from' }), '1'),
      expect(
        role('complementary', { name: 'Effect on open cases' }),
      ).toContainText('moves from'),
    )
  })

  test('an inconsistent threshold is explained next to the field', () => {
    scene(
      { update, view },
      given(loadedModel),
      click(role('button', { name: 'Rules' })),
      type(role('spinbutton', { name: 'Medium from' }), '8'),
      expect(
        text('The medium level must start below the urgent level.'),
      ).toExist(),
    )
  })
})
