import { Result, Schema } from 'effect'

import { issuesToProblems } from './richtext'
import { Furniture, PAGE_TOKENS } from './template'

// NOTE: The theme (D24): one per deployment, set by an administrator. The
// organisation's name, a logo (a reference to an uploaded image), four colours,
// a font for headings and one for text from the bundled set (D16), and the
// default text of the PDF header and footer. A template's own furniture
// overrides the theme's per field (D23).
//
// The shipped default is neutral: no organisation's name, logo or colours.
//
// Colours are six-digit hex. A theme is refused if its text would be
// unreadable: WCAG 2.x contrast of at least 4.5:1 (AA) for the pairs that carry
// text: the body text on the background, and the primary and accent colours on
// the background (links, headings, buttons whose label is the background).

export const THEME_SCHEMA_VERSION = 1

// NOTE: The fonts bundled with the app (D16), covering Latin, Greek and
// Cyrillic.
export const BUNDLED_FONTS = [
  'Hanken Grotesk',
  'Inter',
  'Source Serif 4',
  'Noto Sans',
] as const
export const FontFamily = Schema.Literals(BUNDLED_FONTS)
export type FontFamily = typeof FontFamily.Type

export const HexColour = Schema.String.check(
  Schema.isPattern(/^#[0-9a-fA-F]{6}$/),
)

export const MIN_TEXT_CONTRAST = 4.5

export const ThemeImageId = Schema.String.check(
  Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/),
)

export const Theme = Schema.Struct({
  schemaVersion: Schema.Literal(THEME_SCHEMA_VERSION),
  organisationName: Schema.Trimmed.check(
    Schema.isNonEmpty(),
    Schema.isMaxLength(100),
  ),
  logo: Schema.optionalKey(ThemeImageId),
  colors: Schema.Struct({
    primary: HexColour,
    accent: HexColour,
    text: HexColour,
    background: HexColour,
  }),
  fonts: Schema.Struct({ heading: FontFamily, body: FontFamily }),
  pdf: Furniture,
})
export type Theme = typeof Theme.Type

export const DEFAULT_THEME: Theme = {
  schemaVersion: THEME_SCHEMA_VERSION,
  organisationName: 'Your organisation',
  colors: {
    primary: '#1f4e79',
    accent: '#9a3412',
    text: '#1a1a1a',
    background: '#ffffff',
  },
  fonts: { heading: 'Hanken Grotesk', body: 'Inter' },
  pdf: { footer: 'Page {page} of {pages}' },
}

// ---- Contrast -----------------------------------------------------------------------

const channel = (value: number): number => {
  const unit = value / 255
  return unit <= 0.03928 ? unit / 12.92 : ((unit + 0.055) / 1.055) ** 2.4
}

// NOTE: `#rrggbb` to its red, green and blue, 0 to 255. Throws on anything else;
// validate with `HexColour` first.
export const parseHex = (hex: string): readonly [number, number, number] => {
  if (!/^#[0-9a-fA-F]{6}$/.test(hex)) {
    throw new Error(`Not a six-digit hex colour: ${hex}`)
  }
  return [
    Number.parseInt(hex.slice(1, 3), 16),
    Number.parseInt(hex.slice(3, 5), 16),
    Number.parseInt(hex.slice(5, 7), 16),
  ]
}

export const relativeLuminance = (hex: string): number => {
  const [r, g, b] = parseHex(hex)
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b)
}

// NOTE: WCAG contrast ratio, from 1 (same colour) to 21 (black on white).
export const contrastRatio = (a: string, b: string): number => {
  const la = relativeLuminance(a)
  const lb = relativeLuminance(b)
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05)
}

// ---- Validation ---------------------------------------------------------------------

export type ThemeProblemCode = 'schema' | 'low-contrast' | 'unknown-token'

export type ThemeProblem = Readonly<{
  code: ThemeProblemCode
  path: ReadonlyArray<string | number>
  message: string
  ratio?: number
  required?: number
}>

type ColourName = keyof Theme['colors']

const TEXT_PAIRS: ReadonlyArray<readonly [ColourName, ColourName]> = [
  ['text', 'background'],
  ['primary', 'background'],
  ['accent', 'background'],
]

export const contrastProblems = (
  colors: Theme['colors'],
): ReadonlyArray<ThemeProblem> =>
  TEXT_PAIRS.flatMap(([foreground, background]) => {
    const ratio = contrastRatio(colors[foreground], colors[background])
    return ratio >= MIN_TEXT_CONTRAST
      ? []
      : [
          {
            code: 'low-contrast' as const,
            path: ['colors', foreground],
            message: `The ${foreground} colour ${colors[foreground]} on the ${background} colour ${colors[background]} has a contrast of ${(Math.floor(ratio * 100) / 100).toFixed(2)}:1; at least ${MIN_TEXT_CONTRAST}:1 is needed to be readable.`,
            ratio,
            required: MIN_TEXT_CONTRAST,
          },
        ]
  })

const tokenProblems = (theme: Theme): ReadonlyArray<ThemeProblem> =>
  (['header', 'footer', 'coverHeader', 'coverFooter'] as const).flatMap(field =>
    (theme.pdf[field]?.match(/\{[^}]*\}/g) ?? [])
      .filter(token => !(PAGE_TOKENS as ReadonlyArray<string>).includes(token))
      .map((token): ThemeProblem => ({
        code: 'unknown-token',
        path: ['pdf', field],
        message: `The token ${token} is unknown; use ${PAGE_TOKENS.join(', ')}`,
      })),
  )

export const themeProblems = (theme: Theme): ReadonlyArray<ThemeProblem> => [
  ...contrastProblems(theme.colors),
  ...tokenProblems(theme),
]

const decodeTheme = Schema.decodeUnknownResult(Theme)

// NOTE: Decodes a theme from stored or submitted JSON and refuses it, with
// every problem found, if it is malformed, has an unknown font or token, or
// would be unreadable.
export const validateTheme = (
  input: unknown,
): Result.Result<Theme, ReadonlyArray<ThemeProblem>> => {
  const decoded = decodeTheme(input, {
    errors: 'all',
    onExcessProperty: 'error',
  })
  if (Result.isFailure(decoded)) {
    return Result.fail(
      issuesToProblems(decoded.failure.issue).map((problem): ThemeProblem => ({
        code: 'schema',
        path: problem.path,
        message: problem.message,
      })),
    )
  }
  const problems = themeProblems(decoded.success)
  return problems.length === 0
    ? Result.succeed(decoded.success)
    : Result.fail(problems)
}
