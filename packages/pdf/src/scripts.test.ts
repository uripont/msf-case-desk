import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { describe, expect, test } from 'vitest'

import { FONT_PACKAGES, familyFor, fileOf } from './fonts'
import {
  SCRIPTS,
  UNSUPPORTED_PLACEHOLDER,
  coversCodePoint,
  printedText,
  rangesOf,
  splitByScript,
} from './scripts'

const scriptsOf = (text: string) =>
  splitByScript(text).map(p => [p.script, p.text])

describe('runs by script (D16)', () => {
  test('Latin text, spaces and punctuation are one run', () => {
    expect(scriptsOf('Hello, world 42.')).toEqual([
      ['latin', 'Hello, world 42.'],
    ])
  })

  test('Greek and Cyrillic words are runs of their own, spaces stay Latin', () => {
    expect(scriptsOf('Hi Καλημέρα мир')).toEqual([
      ['latin', 'Hi '],
      ['greek', 'Καλημέρα'],
      ['latin', ' '],
      ['cyrillic', 'мир'],
    ])
  })

  test('letters outside the basic Latin range use the extended subset', () => {
    expect(scriptsOf('Ștefan Doğan')).toEqual([
      ['latin-ext', 'Ș'],
      ['latin', 'tefan Do'],
      ['latin-ext', 'ğ'],
      ['latin', 'an'],
    ])
  })

  test('composed and decomposed accents print the same', () => {
    expect(printedText('é')).toBe(printedText('é'))
  })

  test('an unsupported script becomes one placeholder, also across spaces', () => {
    expect(printedText('Name: مرحبا بالعالم.')).toBe(
      `Name: ${UNSUPPORTED_PLACEHOLDER}.`,
    )
    expect(printedText('ሰላም ዓለም')).toBe(UNSUPPORTED_PLACEHOLDER)
    expect(printedText('a 你好 b')).toBe(`a ${UNSUPPORTED_PLACEHOLDER} b`)
  })

  test('controls and invisible marks are dropped, a tab is a space', () => {
    expect(printedText('a\u0000b‏c­d\te')).toBe('abcd e')
  })

  test('a long text is split in linear time', () => {
    const started = Date.now()
    splitByScript('word '.repeat(200_000))
    expect(Date.now() - started).toBeLessThan(2000)
  })
})

describe('the font files cover what the runs promise', () => {
  const require = createRequire(import.meta.url)
  const fontkit = createRequire(require.resolve('pdfmake'))('fontkit') as {
    openSync: (file: string) => {
      hasGlyphForCodePoint: (cp: number) => boolean
    }
  }
  const SAMPLES: Readonly<Record<string, ReadonlyArray<number>>> = {
    latin: [0x20, 0x41, 0x7a, 0xe9, 0x2019, 0x2022, 0x20ac],
    'latin-ext': [0x15e, 0x11f, 0x218, 0x1e9e],
    greek: [0x3b1, 0x3a9, 0x3ac],
    cyrillic: [0x416, 0x44f, 0x451],
  }

  test('the ranges of the code agree with the samples', () => {
    for (const script of SCRIPTS) {
      for (const codePoint of SAMPLES[script] ?? []) {
        expect(coversCodePoint(script, codePoint)).toBe(true)
      }
      expect(rangesOf(script).length).toBeGreaterThan(0)
    }
  })

  test.each(
    (
      ['Hanken Grotesk', 'Inter', 'Source Serif 4', 'Noto Sans'] as const
    ).flatMap(family => SCRIPTS.map(script => [family, script] as const)),
  )('%s, %s: every face has the glyphs of the samples', (family, script) => {
    const real = familyFor(family, script)
    const folder = join(dirname(require.resolve(FONT_PACKAGES[real])), 'files')
    for (const face of ['normal', 'bold', 'italics', 'bolditalics'] as const) {
      const font = fontkit.openSync(join(folder, fileOf(family, script, face)))
      for (const codePoint of SAMPLES[script] ?? []) {
        expect(
          font.hasGlyphForCodePoint(codePoint),
          `${fileOf(family, script, face)} lacks U+${codePoint.toString(16)}`,
        ).toBe(true)
      }
    }
  })

  test('Hanken Grotesk has no Greek or Cyrillic, so Noto Sans stands in', () => {
    expect(familyFor('Hanken Grotesk', 'greek')).toBe('Noto Sans')
    expect(familyFor('Hanken Grotesk', 'cyrillic')).toBe('Noto Sans')
    expect(familyFor('Hanken Grotesk', 'latin')).toBe('Hanken Grotesk')
    expect(familyFor('Source Serif 4', 'greek')).toBe('Source Serif 4')
  })
})
