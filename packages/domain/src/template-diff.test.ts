import { describe, expect, test } from 'vitest'

import {
  INTAKE_TEMPLATE,
  type Template,
  diffTemplates,
} from './index'
import { section, textItem } from './template-builders'

const withSections = (extra: Template['sections']): Template => ({
  ...INTAKE_TEMPLATE,
  version: INTAKE_TEMPLATE.version + 1,
  sections: [...INTAKE_TEMPLATE.sections, ...extra],
})

describe('diffTemplates', () => {
  test('a template with no predecessor is all added', () => {
    const changes = diffTemplates(undefined, INTAKE_TEMPLATE)
    expect(changes.length).toBeGreaterThan(0)
    expect(changes.every(c => c.change === 'added')).toBe(true)
  })

  test('the same template has no changes', () => {
    expect(diffTemplates(INTAKE_TEMPLATE, INTAKE_TEMPLATE)).toEqual([])
  })

  test('an added section and its item are reported by id', () => {
    const next = withSections([
      section('extra-section', 'Extra', [textItem('extra-item', 'Extra item')]),
    ])
    const changes = diffTemplates(INTAKE_TEMPLATE, next)
    expect(changes).toContainEqual({
      change: 'added',
      target: 'section',
      id: 'extra-section',
      label: 'Extra',
    })
    expect(changes).toContainEqual({
      change: 'added',
      target: 'item',
      id: 'extra-item',
      label: 'Extra item',
    })
    expect(diffTemplates(next, INTAKE_TEMPLATE).map(c => c.change)).toEqual([
      'removed',
      'removed',
    ])
  })

  test('a changed title is a change of that section only', () => {
    const [first, ...rest] = INTAKE_TEMPLATE.sections
    const next: Template = {
      ...INTAKE_TEMPLATE,
      sections: [{ ...first!, title: 'A new title' }, ...rest],
    }
    expect(diffTemplates(INTAKE_TEMPLATE, next)).toEqual([
      { change: 'changed', target: 'section', id: first!.id, label: 'A new title' },
    ])
  })

  test('roles and settings are reported', () => {
    const next: Template = {
      ...INTAKE_TEMPLATE,
      name: 'Renamed',
      roles: INTAKE_TEMPLATE.roles.slice(1),
    }
    const changes = diffTemplates(INTAKE_TEMPLATE, next)
    expect(changes).toContainEqual(
      expect.objectContaining({ change: 'removed', target: 'role' }),
    )
    expect(changes).toContainEqual({
      change: 'changed',
      target: 'setting',
      id: 'name',
      label: 'Name',
    })
  })
})
