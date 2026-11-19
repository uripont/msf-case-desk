import fc from 'fast-check'
import { describe, expect, test } from 'vitest'

import {
  DEFAULT_THEME,
  INTAKE_TEMPLATE,
  MIN_TEXT_CONTRAST,
  type Theme,
  contrastRatio,
  themeProblems,
} from '@quoroom/domain'

import { buildPdf, derivedColours } from './definition'
import { renderPdfInNode } from './node'
import { THEME, descriptionOf } from './testing/documents'
import { extractText } from './testing/extract'

const hex = fc
  .tuple(fc.nat(255), fc.nat(255), fc.nat(255))
  .map(
    ([r, g, b]) =>
      `#${[r, g, b].map(value => value.toString(16).padStart(2, '0')).join('')}`,
  )

const validTheme = fc
  .record({ primary: hex, accent: hex, text: hex, background: hex })
  .map(colors => ({ ...DEFAULT_THEME, colors }) satisfies Theme)
  .filter(theme => themeProblems(theme).length === 0)

const lookOf = (theme: Theme) => ({
  headingFont: theme.fonts.heading,
  bodyFont: theme.fonts.body,
  ...theme.colors,
})

describe('derived colours keep the contrast of the theme', () => {
  test('for any valid theme, light or dark', () => {
    fc.assert(
      fc.property(validTheme, theme => {
        const look = lookOf(theme)
        const derived = derivedColours(look)
        for (const other of [look.text, look.primary, look.accent]) {
          expect(
            contrastRatio(derived.tableHeaderFill, other),
          ).toBeGreaterThanOrEqual(MIN_TEXT_CONTRAST)
        }
        expect(
          contrastRatio(derived.furniture, look.background),
        ).toBeGreaterThanOrEqual(MIN_TEXT_CONTRAST)
      }),
      { numRuns: 1000 },
    )
  })

  test('a dark theme gets a dark table header fill and light furniture text', () => {
    const dark = {
      ...DEFAULT_THEME,
      colors: {
        primary: '#9ecbff',
        accent: '#ffb38a',
        text: '#f2f2f2',
        background: '#101820',
      },
    }
    const derived = derivedColours(lookOf(dark))
    expect(contrastRatio(derived.tableHeaderFill, '#f2f2f2')).toBeGreaterThanOrEqual(4.5)
    expect(contrastRatio(derived.furniture, '#101820')).toBeGreaterThanOrEqual(4.5)
  })

  test('a dark theme renders, with its text and the furniture in the file', async () => {
    const dark: Theme = {
      ...THEME,
      colors: {
        primary: '#9ecbff',
        accent: '#ffb38a',
        text: '#f2f2f2',
        background: '#101820',
      },
    }
    const description = descriptionOf(INTAKE_TEMPLATE, { redacted: false, theme: dark })
    const build = buildPdf(description, new Map())
    const sections = build.definition['content'] as ReadonlyArray<{
      background: (page: number) => unknown
    }>
    expect(JSON.stringify(sections[0]?.background(1))).toContain('#101820')
    const text = await extractText(await renderPdfInNode(description, new Map()))
    expect(text).toContain('STRICTLY CONFIDENTIAL')
  })
})
