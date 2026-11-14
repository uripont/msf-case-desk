import { Result } from 'effect'
import { describe, expect, test } from 'vitest'

import {
  DEFAULT_THEME,
  type Theme,
  documentDescription,
  headingsOf,
  sampleDocumentInput,
  validateContent,
  validateTemplate,
} from './index'
import { SAMPLE_CONTENT, SAMPLE_TEMPLATE } from './theme-sample'

const themed: Theme = {
  ...DEFAULT_THEME,
  organisationName: 'Invented Organisation',
  logo: 'logo-1',
  colors: { ...DEFAULT_THEME.colors, primary: '#0b5d3b' },
  fonts: { heading: 'Source Serif 4', body: 'Noto Sans' },
  pdf: {
    header: 'STRICTLY CONFIDENTIAL',
    footer: '{case} - page {page} of {pages}',
  },
}

describe('the sample document for the theme preview', () => {
  test('the template and the content are valid', () => {
    expect(Result.isSuccess(validateTemplate(SAMPLE_TEMPLATE))).toBe(true)
    expect(
      Result.isSuccess(validateContent(SAMPLE_TEMPLATE, SAMPLE_CONTENT)),
    ).toBe(true)
  })

  test('it takes the look from the theme it is given', () => {
    const description = documentDescription(sampleDocumentInput(themed))
    expect(description.style.primary).toBe('#0b5d3b')
    expect(description.style.headingFont).toBe('Source Serif 4')
    expect(description.info.author).toBe('Invented Organisation')
    expect(description.imageIds).toEqual(['logo-1'])
    expect(description.furniture.normal.header).toBeDefined()
    expect(description.furniture.normal.footer).toBeDefined()
    expect(headingsOf(description).length).toBeGreaterThan(0)
  })

  test('without a logo the document names no image', () => {
    const description = documentDescription(sampleDocumentInput(DEFAULT_THEME))
    expect(description.imageIds).toEqual([])
  })
})
