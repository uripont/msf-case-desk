import { Result } from 'effect'
import { describe, expect, test } from 'vitest'

import { INTAKE_TEMPLATE, INVESTIGATION_TEMPLATE } from './builtin-templates'
import { templateToForm } from './template-form'
import {
  type FormEdit,
  applyEdit,
  formProblems,
  freshId,
  templateOfForm,
} from './template-form-edit'
import { PANEL_EDITS, PANEL_START } from './testing/template-edits'
import { PANEL_TEMPLATE } from './testing/templates'

const apply = (form: ReturnType<typeof templateToForm>, ...edits: ReadonlyArray<FormEdit>) =>
  edits.reduce(applyEdit, form)

const built = (form: ReturnType<typeof templateToForm>) => {
  const result = templateOfForm(form)
  if (Result.isFailure(result)) {
    throw new Error(JSON.stringify(result.failure))
  }
  return result.success
}

describe('building the panel template from a blank draft', () => {
  test('the blank draft is valid, and the edits give exactly the invented panel template', () => {
    expect(Result.isSuccess(templateOfForm(PANEL_START))).toBe(true)
    const form = PANEL_EDITS.reduce(applyEdit, PANEL_START)
    expect(built(form)).toEqual(PANEL_TEMPLATE)
  })

  test('every prefix of the script is the same each time', () => {
    const once = PANEL_EDITS.reduce(applyEdit, PANEL_START)
    const twice = PANEL_EDITS.reduce(applyEdit, PANEL_START)
    expect(once).toEqual(twice)
  })
})

describe('applyEdit', () => {
  const intake = templateToForm(INTAKE_TEMPLATE)
  const investigation = templateToForm(INVESTIGATION_TEMPLATE)

  test('a built-in template is the same after no edit and after an edit and its undo', () => {
    expect(built(intake)).toEqual(INTAKE_TEMPLATE)
    const changed = apply(
      intake,
      { _tag: 'SetText', field: 'name', value: 'Other' },
      { _tag: 'SetText', field: 'name', value: INTAKE_TEMPLATE.name },
    )
    expect(built(changed)).toEqual(INTAKE_TEMPLATE)
  })

  test('removing a section removes its subsections, items, options, cover lines and what stays in force', () => {
    const section = investigation.sections.find(row => row.parentId === null && !row.isConclusion)
    if (section === undefined) throw new Error('no section')
    const gone = apply(investigation, { _tag: 'RemoveSection', id: section.id })
    const ids = new Set(gone.sections.map(row => row.id))
    expect(ids.has(section.id)).toBe(false)
    expect(gone.items.every(row => ids.has(row.parentId) || gone.items.some(p => p.id === row.parentId))).toBe(true)
    expect(gone.options.every(row => gone.items.some(item => item.id === row.itemId))).toBe(true)
    expect(gone.endingStaysInForce.every(id => ids.has(id))).toBe(true)
    expect(gone.coverParts.every(part => part.kind !== 'item' || gone.items.some(item => item.id === part.itemId))).toBe(true)
  })

  test('a renamed section, item and option are followed by everything that pointed at them', () => {
    const select = intake.items.find(row => row.endOptionId !== '')
    if (select === undefined) throw new Error('no end answer in the intake template')
    const renamed = apply(
      intake,
      { _tag: 'Rename', scope: 'option', id: select.endOptionId, newId: 'renamed-option' },
      { _tag: 'Rename', scope: 'item', id: select.id, newId: 'renamed-item' },
    )
    expect(renamed.items.find(row => row.id === 'renamed-item')?.endOptionId).toBe('renamed-option')
    expect(renamed.options.filter(row => row.itemId === 'renamed-item').length).toBeGreaterThan(0)
    expect(formProblems(renamed)).toEqual([])
    const section = investigation.sections[0]
    if (section === undefined) throw new Error('no section')
    const again = apply(investigation, { _tag: 'Rename', scope: 'section', id: section.id, newId: 'renamed-section' })
    expect(formProblems(again)).toEqual([])
    expect(again.items.every(row => row.parentId !== section.id)).toBe(true)
  })

  test('moving, nesting and promoting sections keeps the template valid', () => {
    const base = PANEL_EDITS.reduce(applyEdit, PANEL_START)
    const down = apply(base, { _tag: 'MoveSection', id: 'overview', direction: 'down' })
    expect(built(down).sections.map(s => s.id)).toEqual(['items-reviewed', 'overview', 'outcome'])
    const nested = apply(base, { _tag: 'MoveSection', id: 'outcome', direction: 'in' })
    expect(built(nested).sections.map(s => s.id)).toEqual(['overview', 'items-reviewed'])
    expect(built(nested).sections[1]?.sections.map(s => s.id)).toEqual(['remarks', 'outcome'])
    const out = apply(base, { _tag: 'MoveSection', id: 'remarks', direction: 'out' })
    expect(built(out).sections.map(s => s.id)).toEqual(['overview', 'items-reviewed', 'remarks', 'outcome'])
    expect(apply(base, { _tag: 'MoveSection', id: 'overview', direction: 'up' })).toEqual(base)
    expect(apply(base, { _tag: 'MoveSection', id: 'overview', direction: 'in' })).toEqual(base)
  })

  test('a conclusion is added once, stays last, and can be written by the drafting role', () => {
    const base = PANEL_EDITS.reduce(applyEdit, PANEL_START)
    const added = apply(
      base,
      { _tag: 'AddSection', id: 'c1', parentId: null, isConclusion: true },
      { _tag: 'AddSection', id: 'c2', parentId: null, isConclusion: true },
      { _tag: 'AddItem', id: 'c-text', parentId: 'c1', type: 'rich_text' },
    )
    expect(added.sections.filter(row => row.isConclusion).map(row => row.id)).toEqual(['c1'])
    const problems = formProblems(added)
    expect(problems.map(entry => entry.problem.code)).toContain('conclusion-permission-missing')
    const fixed = apply(added, { _tag: 'TogglePermission', id: 'drafters', permission: 'write_conclusion' })
    expect(built(fixed).conclusion?.id).toBe('c1')
  })

  test('the drafting role keeps its required permissions and the full view', () => {
    const base = PANEL_EDITS.reduce(applyEdit, PANEL_START)
    expect(apply(base, { _tag: 'TogglePermission', id: 'drafters', permission: 'publish' })).toEqual(base)
    expect(apply(base, { _tag: 'SetRoleView', id: 'drafters', value: 'redacted' })).toEqual(base)
    expect(apply(base, { _tag: 'TogglePermission', id: 'drafters', permission: 'vote' })).toEqual(base)
    const second = apply(base, { _tag: 'AddRole', id: 'extra', kind: 'drafting' })
    expect(formProblems(second).map(entry => entry.problem.code)).toContain('several-drafting-roles')
    const none = apply(base, { _tag: 'SetRoleKind', id: 'drafters', value: 'reviewing' })
    expect(formProblems(none).map(entry => entry.problem.code)).toContain('no-drafting-role')
  })

  test('voting and the approval rule go together', () => {
    const base = PANEL_EDITS.reduce(applyEdit, PANEL_START)
    const noVote = apply(base, { _tag: 'TogglePermission', id: 'members', permission: 'vote' })
    expect(noVote.roles.find(role => role.id === 'members')?.approvalKind).toBe('')
    const votes = apply(noVote, { _tag: 'TogglePermission', id: 'members', permission: 'vote' })
    expect(votes.roles.find(role => role.id === 'members')?.approvalKind).toBe('all')
    const none = apply(
      base,
      { _tag: 'TogglePermission', id: 'chair', permission: 'vote' },
      { _tag: 'TogglePermission', id: 'members', permission: 'vote' },
    )
    expect(formProblems(none).map(entry => entry.problem.code)).toContain('no-voting-role')
  })

  test('a select with an end answer, then the answer removed', () => {
    const base = PANEL_EDITS.reduce(applyEdit, PANEL_START)
    const ending = apply(
      base,
      { _tag: 'SetEndOption', id: 'outcome-choice', optionId: 'decline' },
    )
    expect(formProblems(ending).map(entry => entry.problem.code)).toContain('ending-missing')
    const withText = apply(ending, { _tag: 'SetText', field: 'endingOutcomeText', value: 'The matter ends here.' })
    expect(formProblems(withText)).toEqual([])
    const without = apply(withText, { _tag: 'RemoveOption', id: 'decline' })
    expect(without.items.find(row => row.id === 'outcome-choice')?.endOptionId).toBe('')
  })

  test('cover lines and their parts', () => {
    const base = PANEL_EDITS.reduce(applyEdit, PANEL_START)
    const cover = apply(
      base,
      { _tag: 'AddCoverLine' },
      { _tag: 'SetCoverEmphasis', index: 0, value: 'title' },
      { _tag: 'AddCoverPart', lineIndex: 0, kind: 'case_value' },
      { _tag: 'AddCoverLine' },
      { _tag: 'AddCoverPart', lineIndex: 1, kind: 'item' },
      { _tag: 'SetCoverPart', lineIndex: 1, partIndex: 1, field: 'itemId', value: 'panel-topic' },
    )
    const template = built(cover)
    expect(template.cover?.lines.map(line => line.parts.length)).toEqual([2, 2])
    expect(template.cover?.lines[1]?.parts[1]).toEqual({ kind: 'item', itemId: 'panel-topic' })
    const fewer = apply(cover, { _tag: 'RemoveCoverLine', index: 0 })
    expect(built(fewer).cover?.lines.length).toBe(1)
    expect(built(fewer).cover?.lines[0]?.parts[1]).toEqual({ kind: 'item', itemId: 'panel-topic' })
    const removedItem = apply(cover, { _tag: 'RemoveItem', id: 'panel-topic' })
    expect(removedItem.coverParts.some(part => part.itemId === 'panel-topic')).toBe(false)
  })

  test('freshId never repeats an ID of the form', () => {
    const base = PANEL_EDITS.reduce(applyEdit, PANEL_START)
    expect(freshId(base, 'section', 1)).toBe('section-1')
    const added = apply(base, { _tag: 'AddSection', id: 'section-1', parentId: null, isConclusion: false })
    expect(freshId(added, 'section', 1)).toBe('section-2')
  })
})

describe('where a problem belongs', () => {
  test('each problem of a broken form names the row it is about', () => {
    const base = PANEL_EDITS.reduce(applyEdit, PANEL_START)
    const broken = apply(
      base,
      { _tag: 'SetApproval', id: 'members', kind: 'at_least', count: 0 },
      { _tag: 'SetItemRepeat', id: 'finding-list', min: 3, max: 1 },
      { _tag: 'SetText', field: 'header', value: '{nope}' },
      { _tag: 'AddItem', id: 'lonely', parentId: 'no-such-section', type: 'text' },
    )
    const found = formProblems(broken)
    const empty = formProblems(
      apply(base, { _tag: 'SetSectionText', id: 'remarks', field: 'title', value: '   ' }),
    )
    expect(empty.some(entry => entry.target.scope === 'section' && entry.target.id === 'remarks' && entry.target.field === 'title')).toBe(true)
    const at = (scope: string, id: string) =>
      found.filter(entry => entry.target.scope === scope && entry.target.id === id)
    expect(at('role', 'members').some(entry => entry.target.field === 'approval')).toBe(true)
    expect(at('item', 'finding-list').length).toBeGreaterThan(0)
    expect(found.some(entry => entry.target.scope === 'furniture' || entry.target.field === 'furniture')).toBe(true)
    expect(at('item', 'lonely').length).toBeGreaterThan(0)
  })

  test('a duplicate ID is shown on the rows that share it', () => {
    const base = PANEL_EDITS.reduce(applyEdit, PANEL_START)
    const dup = apply(base, { _tag: 'Rename', scope: 'section', id: 'remarks', newId: 'outcome' })
    const found = formProblems(dup).filter(entry => entry.problem.code === 'duplicate-id')
    expect(found.length).toBeGreaterThan(0)
    expect(found.some(entry => entry.target.scope === 'section' && entry.target.id === 'outcome')).toBe(true)
  })
})
