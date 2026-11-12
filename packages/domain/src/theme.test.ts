import { Result } from 'effect'
import fc from 'fast-check'
import { describe, expect, test } from 'vitest'

import {
  BUNDLED_FONTS,
  DEFAULT_THEME,
  MIN_TEXT_CONTRAST,
  type Theme,
  contrastRatio,
  themeProblems,
  validateTheme,
} from './index'

const withColors = (colors: Partial<Theme['colors']>): Theme => ({
  ...DEFAULT_THEME,
  colors: { ...DEFAULT_THEME.colors, ...colors },
})

const problemsOf = (input: unknown) => {
  const result = validateTheme(input)
  return Result.isFailure(result) ? result.failure : []
}

describe('contrast ratio', () => {
  test('known values', () => {
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 5)
    expect(contrastRatio('#ffffff', '#ffffff')).toBeCloseTo(1, 5)
    // The classic AA edge: #767676 on white passes, #777777 does not.
    expect(contrastRatio('#767676', '#ffffff')).toBeGreaterThanOrEqual(4.5)
    expect(contrastRatio('#777777', '#ffffff')).toBeLessThan(4.5)
  })

  test('symmetric and between 1 and 21', () => {
    const hex = fc
      .integer({ min: 0, max: 0xffffff })
      .map(n => `#${n.toString(16).padStart(6, '0')}`)
    fc.assert(
      fc.property(hex, hex, (a, b) => {
        const ratio = contrastRatio(a, b)
        expect(ratio).toBeCloseTo(contrastRatio(b, a), 10)
        expect(ratio).toBeGreaterThanOrEqual(1)
        expect(ratio).toBeLessThanOrEqual(21.0000001)
      }),
    )
  })
})

describe('the default theme', () => {
  test('is accepted, also after a JSON round trip', () => {
    expect(themeProblems(DEFAULT_THEME)).toEqual([])
    const result = validateTheme(JSON.parse(JSON.stringify(DEFAULT_THEME)))
    expect(Result.isSuccess(result)).toBe(true)
  })

  test('is neutral: no logo, no organisation material, bundled fonts', () => {
    expect(DEFAULT_THEME.logo).toBeUndefined()
    expect(JSON.stringify(DEFAULT_THEME).toLowerCase()).not.toMatch(
      /msf|médecins|medecins|sans fronti/,
    )
    expect(BUNDLED_FONTS).toContain(DEFAULT_THEME.fonts.heading)
    expect(BUNDLED_FONTS).toContain(DEFAULT_THEME.fonts.body)
  })

  test('every text pair passes AA with some room', () => {
    const { colors } = DEFAULT_THEME
    for (const key of ['text', 'primary', 'accent'] as const) {
      expect(
        contrastRatio(colors[key], colors.background),
      ).toBeGreaterThanOrEqual(MIN_TEXT_CONTRAST)
    }
  })
})

describe('refusing unreadable themes', () => {
  test('low contrast gives a coded problem for the colour at fault', () => {
    const problems = problemsOf(withColors({ text: '#999999' }))
    expect(problems).toHaveLength(1)
    expect(problems[0]).toMatchObject({
      code: 'low-contrast',
      path: ['colors', 'text'],
      required: 4.5,
    })
    expect(problems[0]?.ratio).toBeLessThan(4.5)
  })

  test('each of the three pairs is checked', () => {
    for (const key of ['text', 'primary', 'accent'] as const) {
      const problems = problemsOf(withColors({ [key]: '#eeeeee' }))
      expect(problems.map(p => p.path)).toEqual([['colors', key]])
    }
  })

  test('a dark theme with light text is fine, dark on dark is not', () => {
    expect(
      problemsOf(
        withColors({
          background: '#101820',
          text: '#f5f5f5',
          primary: '#9ecbff',
          accent: '#ffb27a',
        }),
      ),
    ).toEqual([])
    expect(
      problemsOf(withColors({ background: '#101820', text: '#202830' })).map(
        p => p.code,
      ),
    ).toContain('low-contrast')
  })

  test('agrees with the ratio for any text and background', () => {
    const hex = fc
      .integer({ min: 0, max: 0xffffff })
      .map(n => `#${n.toString(16).padStart(6, '0')}`)
    fc.assert(
      fc.property(hex, hex, (text, background) => {
        const problems = themeProblems(withColors({ text, background })).filter(
          p => p.path[1] === 'text',
        )
        expect(problems.length === 0).toBe(
          contrastRatio(text, background) >= 4.5,
        )
      }),
      { numRuns: 300 },
    )
  })

  test('malformed colours, unknown fonts and extra keys are schema problems', () => {
    expect(
      problemsOf(withColors({ primary: 'blue' })).map(p => p.code),
    ).toEqual(['schema'])
    expect(
      problemsOf(withColors({ primary: '#abc' })).map(p => p.code),
    ).toEqual(['schema'])
    expect(
      problemsOf({
        ...DEFAULT_THEME,
        fonts: { heading: 'Comic Sans', body: 'Inter' },
      }).map(p => p.code),
    ).toEqual(['schema'])
    expect(
      problemsOf({ ...DEFAULT_THEME, surprise: true }).length,
    ).toBeGreaterThan(0)
    expect(
      problemsOf({ ...DEFAULT_THEME, organisationName: '  ' }).length,
    ).toBeGreaterThan(0)
    expect(problemsOf(42).length).toBeGreaterThan(0)
  })

  test('an unknown token in the PDF text is refused', () => {
    const theme: Theme = { ...DEFAULT_THEME, pdf: { header: 'Page {number}' } }
    expect(problemsOf(theme)).toEqual([
      expect.objectContaining({
        code: 'unknown-token',
        path: ['pdf', 'header'],
      }),
    ])
    expect(
      Result.isSuccess(
        validateTheme({
          ...DEFAULT_THEME,
          pdf: {
            header: 'STRICTLY CONFIDENTIAL',
            footer: '{case} - {page} of {pages} - {title}',
          },
        }),
      ),
    ).toBe(true)
  })

  test('a logo is an image reference, not a path', () => {
    expect(
      Result.isSuccess(validateTheme({ ...DEFAULT_THEME, logo: 'logo-1' })),
    ).toBe(true)
    expect(
      problemsOf({ ...DEFAULT_THEME, logo: '../x' }).map(p => p.code),
    ).toEqual(['schema'])
  })
})
