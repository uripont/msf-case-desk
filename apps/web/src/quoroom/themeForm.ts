import { Array, Option, Result, Schema } from 'effect'

import {
  type FontFamily,
  FontFamily as FontFamilySchema,
  MIN_TEXT_CONTRAST,
  THEME_SCHEMA_VERSION,
  type Theme,
  type ThemeProblem,
  contrastRatio,
  validateTheme,
} from '@case-desk/domain'

// NOTE: The theme screen's form (stage 9d), kept as plain text the way it is
// typed. `candidateOf` turns it into what the domain checks, and the domain
// decides what is a problem (`validateTheme`): the screen never has a second
// opinion about contrast, fonts or tokens, it only places each problem next to
// the field it is about.

export const COLOUR_NAMES = ['primary', 'accent', 'text', 'background'] as const
export const ColourName = Schema.Literals(COLOUR_NAMES)
export type ColourName = typeof ColourName.Type

export const PDF_TEXT_FIELDS = [
  'header',
  'footer',
  'coverHeader',
  'coverFooter',
] as const
export const PdfTextField = Schema.Literals(PDF_TEXT_FIELDS)
export type PdfTextField = typeof PdfTextField.Type

export const FontRole = Schema.Literals(['heading', 'body'])
export type FontRole = typeof FontRole.Type

export const ThemeFields = Schema.Struct({
  organisationName: Schema.String,
  primary: Schema.String,
  accent: Schema.String,
  text: Schema.String,
  background: Schema.String,
  headingFont: FontFamilySchema,
  bodyFont: FontFamilySchema,
  header: Schema.String,
  footer: Schema.String,
  coverHeader: Schema.String,
  coverFooter: Schema.String,
  maybeLogoId: Schema.Option(Schema.String),
})
export type ThemeFields = typeof ThemeFields.Type

export const fieldsOf = (theme: Theme): ThemeFields => ({
  organisationName: theme.organisationName,
  primary: theme.colors.primary,
  accent: theme.colors.accent,
  text: theme.colors.text,
  background: theme.colors.background,
  headingFont: theme.fonts.heading,
  bodyFont: theme.fonts.body,
  header: theme.pdf.header ?? '',
  footer: theme.pdf.footer ?? '',
  coverHeader: theme.pdf.coverHeader ?? '',
  coverFooter: theme.pdf.coverFooter ?? '',
  maybeLogoId: Option.fromNullishOr(theme.logo),
})

const colourOf = (text: string): string => text.trim().toLowerCase()

const pdfOf = (fields: ThemeFields): Theme['pdf'] => ({
  ...(fields.header === '' ? {} : { header: fields.header }),
  ...(fields.footer === '' ? {} : { footer: fields.footer }),
  ...(fields.coverHeader === '' ? {} : { coverHeader: fields.coverHeader }),
  ...(fields.coverFooter === '' ? {} : { coverFooter: fields.coverFooter }),
})

export const candidateOf = (fields: ThemeFields): unknown => ({
  schemaVersion: THEME_SCHEMA_VERSION,
  organisationName: fields.organisationName.trim(),
  ...Option.match(fields.maybeLogoId, {
    onNone: () => ({}),
    onSome: logo => ({ logo }),
  }),
  colors: {
    primary: colourOf(fields.primary),
    accent: colourOf(fields.accent),
    text: colourOf(fields.text),
    background: colourOf(fields.background),
  },
  fonts: { heading: fields.headingFont, body: fields.bodyFont },
  pdf: pdfOf(fields),
})

export const checkFields = (
  fields: ThemeFields,
): Result.Result<Theme, ReadonlyArray<ThemeProblem>> =>
  validateTheme(candidateOf(fields))

export const problemsOfFields = (
  fields: ThemeFields,
): ReadonlyArray<ThemeProblem> =>
  Result.match(checkFields(fields), {
    onFailure: problems => problems,
    onSuccess: () => [],
  })

export const themeOfFields = (fields: ThemeFields): Option.Option<Theme> =>
  Result.match(checkFields(fields), {
    onFailure: () => Option.none(),
    onSuccess: Option.some,
  })

// NOTE: Which field a problem is shown beside: the colour or the text it
// names, the organisation's name, the fonts.
export const fieldKeyOf = (problem: ThemeProblem): string =>
  problem.path.join('.')

export const problemsAt = (
  problems: ReadonlyArray<ThemeProblem>,
  key: string,
): ReadonlyArray<ThemeProblem> =>
  Array.filter(problems, problem => fieldKeyOf(problem) === key)

// NOTE: The domain's coded messages for contrast and tokens are fixed text.
// A malformed value is described here in plain words.
export const problemText = (problem: ThemeProblem): string => {
  if (problem.code !== 'schema') {
    return problem.message
  }
  if (problem.path[0] === 'colors') {
    return 'Use six hexadecimal digits with a leading #, for example #1f4e79.'
  }
  if (problem.path[0] === 'organisationName') {
    return 'Give the organisation a name of at most 100 characters.'
  }
  if (problem.path[0] === 'pdf') {
    return 'This text is too long (at most 300 characters).'
  }
  return 'This value is not accepted.'
}

const HEX = /^#[0-9a-f]{6}$/

export const isHex = (text: string): boolean => HEX.test(colourOf(text))

// NOTE: the ratio of two typed colours when both are valid, shown beside a
// colour so the person sees how far from readable it is.
export const ratioText = (
  foreground: string,
  background: string,
): Option.Option<string> =>
  isHex(foreground) && isHex(background)
    ? Option.some(
        `${(Math.floor(contrastRatio(colourOf(foreground), colourOf(background)) * 100) / 100).toFixed(2)}:1`,
      )
    : Option.none()

export const READABLE_RATIO = MIN_TEXT_CONTRAST

export const fontChoice = (value: string): FontFamily | undefined =>
  Schema.is(FontFamilySchema)(value) ? value : undefined
