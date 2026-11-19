import type { FontFamily } from '@quoroom/domain'

import type { Script } from './scripts'

// NOTE: The font files of a PDF (D16). They are the static `.woff` files of
// the `@fontsource` packages: four faces per family and script (regular,
// bold, italic, bold italic), named `<family>-<script>-<weight>-<style>.woff`.
// A family that has no file for a script (Hanken Grotesk has no Greek or plain
// Cyrillic) is replaced by Noto Sans for that script's runs.

export type Face = 'normal' | 'bold' | 'italics' | 'bolditalics'

const SLUGS: Readonly<Record<FontFamily, string>> = {
  'Hanken Grotesk': 'hanken-grotesk',
  Inter: 'inter',
  'Source Serif 4': 'source-serif-4',
  'Noto Sans': 'noto-sans',
}

export const FONT_PACKAGES: Readonly<Record<FontFamily, string>> = {
  'Hanken Grotesk': '@fontsource/hanken-grotesk',
  Inter: '@fontsource/inter',
  'Source Serif 4': '@fontsource/source-serif-4',
  'Noto Sans': '@fontsource/noto-sans',
}

const COVERAGE: Readonly<Record<FontFamily, ReadonlyArray<Script>>> = {
  'Hanken Grotesk': ['latin', 'latin-ext'],
  Inter: ['latin', 'latin-ext', 'greek', 'cyrillic'],
  'Source Serif 4': ['latin', 'latin-ext', 'greek', 'cyrillic'],
  'Noto Sans': ['latin', 'latin-ext', 'greek', 'cyrillic'],
}

export const FALLBACK_FAMILY: FontFamily = 'Noto Sans'

export const familyFor = (family: FontFamily, script: Script): FontFamily =>
  COVERAGE[family].includes(script) ? family : FALLBACK_FAMILY

export const slugOf = (family: FontFamily): string => SLUGS[family]

const FILE_PARTS: Readonly<Record<Face, string>> = {
  normal: '400-normal',
  bold: '700-normal',
  italics: '400-italic',
  bolditalics: '700-italic',
}

// NOTE: The name pdfmake knows a font by: one per family and script.
export const fontName = (family: FontFamily, script: Script): string =>
  `${slugOf(familyFor(family, script))}~${script}`

export const fileOf = (
  family: FontFamily,
  script: Script,
  face: Face,
): string =>
  `${slugOf(familyFor(family, script))}-${script}-${FILE_PARTS[face]}.woff`

export type FontDefinition = Readonly<Record<Face, string>>

export const definitionOf = (
  family: FontFamily,
  script: Script,
): FontDefinition => ({
  normal: fileOf(family, script, 'normal'),
  bold: fileOf(family, script, 'bold'),
  italics: fileOf(family, script, 'italics'),
  bolditalics: fileOf(family, script, 'bolditalics'),
})

// NOTE: The package folder and file name of a font file, for an adapter that
// reads it from disk or bundles it: `{ family, file }`.
export const familyOfFile = (file: string): FontFamily | undefined =>
  (Object.keys(SLUGS) as Array<FontFamily>).find(family =>
    file.startsWith(`${SLUGS[family]}-`),
  )
