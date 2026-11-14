import { Result } from 'effect'
import { describe, expect, test } from 'vitest'

import {
  INTAKE_TEMPLATE,
  INVESTIGATION_TEMPLATE,
  type Template,
  numberSections,
  sectionStates,
  validateContent,
} from './index'
import { fullContent, instructionTexts } from './testing/fixtures'
import { PANEL_TEMPLATE } from './testing/templates'

// NOTE: A report that fills every item of a template is valid,
// complete everywhere, and holds none of the instruction texts. The JSON files
// the browser check compares with are checked in `apps/api` (they need files).

const TEMPLATES: ReadonlyArray<readonly [string, Template]> = [
  ['intake', INTAKE_TEMPLATE],
  ['investigation', INVESTIGATION_TEMPLATE],
  ['panel', PANEL_TEMPLATE],
]

describe.each(TEMPLATES)('the full fixture of %s', (name, template) => {
  const content = fullContent(template)

  test('it fits the template', () => {
    expect(Result.isSuccess(validateContent(template, content))).toBe(true)
  })

  test('every section is complete', () => {
    const states = sectionStates(template, content)
    for (const row of numberSections(template, content)) {
      expect(states.get(row.key), row.key).toBe('complete')
    }
  })

  test('it holds none of the instruction texts', () => {
    const text = JSON.stringify(content)
    for (const instruction of instructionTexts(template)) {
      expect(text.includes(instruction), instruction).toBe(false)
    }
  })

  test('marking an optional section not applicable keeps it valid and the numbers', () => {
    const marked = fullContent(template, {
      notApplicable: template.sections
        .filter(section => section.requirement === 'optional_with_reason')
        .map(section => section.id),
    })
    expect(Result.isSuccess(validateContent(template, marked))).toBe(true)
    expect(numberSections(template, marked)).toEqual(
      numberSections(template, content),
    )
  })
})
