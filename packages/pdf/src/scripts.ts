// NOTE: Splitting text into runs by script (D16). The bundled fonts are
// `.woff` subsets per script (fontkit cannot read `.woff2`), and pdfmake has no
// per-glyph fallback, so each run is given the font file of its own subset.
// Spaces, digits and punctuation belong to the Latin subset. A character that
// no subset covers (Arabic, Amharic, Chinese, symbols) is never handed to a
// font: a run of them is replaced by one clear placeholder (D16).

export type Script = 'latin' | 'latin-ext' | 'greek' | 'cyrillic'

export const SCRIPTS: ReadonlyArray<Script> = [
  'latin',
  'latin-ext',
  'greek',
  'cyrillic',
]

export const UNSUPPORTED_PLACEHOLDER = '[text in an unsupported script]'

export type Piece = Readonly<{ script: Script; text: string }>

type Range = readonly [number, number]

// NOTE: The `unicode-range` of the fontsource subsets, as published in their
// CSS (identical for the four families).
const RANGES: Readonly<Record<Script, ReadonlyArray<Range>>> = {
  latin: [
    [0x0000, 0x00ff],
    [0x0131, 0x0131],
    [0x0152, 0x0153],
    [0x02bb, 0x02bc],
    [0x02c6, 0x02c6],
    [0x02da, 0x02da],
    [0x02dc, 0x02dc],
    [0x0304, 0x0304],
    [0x0308, 0x0308],
    [0x0329, 0x0329],
    [0x2000, 0x206f],
    [0x20ac, 0x20ac],
    [0x2122, 0x2122],
    [0x2191, 0x2191],
    [0x2193, 0x2193],
    [0x2212, 0x2212],
    [0x2215, 0x2215],
    [0xfeff, 0xfeff],
    [0xfffd, 0xfffd],
  ],
  'latin-ext': [
    [0x0100, 0x02ba],
    [0x02bd, 0x02c5],
    [0x02c7, 0x02cc],
    [0x02ce, 0x02d7],
    [0x02dd, 0x02ff],
    [0x0304, 0x0304],
    [0x0308, 0x0308],
    [0x0329, 0x0329],
    [0x1d00, 0x1dbf],
    [0x1e00, 0x1e9f],
    [0x1ef2, 0x1eff],
    [0x2020, 0x2020],
    [0x20a0, 0x20ab],
    [0x20ad, 0x20c0],
    [0x2113, 0x2113],
    [0x2c60, 0x2c7f],
    [0xa720, 0xa7ff],
  ],
  greek: [
    [0x0370, 0x0377],
    [0x037a, 0x037f],
    [0x0384, 0x038a],
    [0x038c, 0x038c],
    [0x038e, 0x03a1],
    [0x03a3, 0x03ff],
  ],
  cyrillic: [
    [0x0301, 0x0301],
    [0x0400, 0x045f],
    [0x0490, 0x0491],
    [0x04b0, 0x04b1],
    [0x2116, 0x2116],
  ],
}

// NOTE: Written in the order a code point is tried: Latin first, so a shared
// code point such as U+0308 stays in the run it follows.
const ORDER: ReadonlyArray<Script> = ['latin', 'latin-ext', 'greek', 'cyrillic']

export const coversCodePoint = (script: Script, codePoint: number): boolean =>
  RANGES[script].some(([from, to]) => codePoint >= from && codePoint <= to)

export const rangesOf = (script: Script): ReadonlyArray<Range> => RANGES[script]

// NOTE: Characters that print nothing and that the Latin subset happens to
// list (zero-width and direction marks) are dropped: they would only confuse
// the layout, and a bidirectional mark would suggest a shaping that is not done.
const isInvisible = (codePoint: number): boolean =>
  (codePoint >= 0x200b && codePoint <= 0x200f) ||
  (codePoint >= 0x202a && codePoint <= 0x202e) ||
  (codePoint >= 0x2060 && codePoint <= 0x2064) ||
  codePoint === 0xfeff ||
  codePoint === 0x00ad

const isControl = (codePoint: number): boolean =>
  (codePoint < 0x20 && codePoint !== 0x0a) ||
  (codePoint >= 0x7f && codePoint <= 0x9f)

const COMBINING = /^\p{Mn}$/u

type Tagged = Readonly<{ script: Script | 'unsupported'; text: string }>

const classify = (character: string): Tagged | undefined => {
  const codePoint = character.codePointAt(0) ?? 0
  if (codePoint === 0x09 || codePoint === 0x00a0) {
    return { script: 'latin', text: ' ' }
  }
  if (isControl(codePoint) || isInvisible(codePoint)) return undefined
  const script = ORDER.find(candidate => coversCodePoint(candidate, codePoint))
  if (script !== undefined) return { script, text: character }
  if (COMBINING.test(character)) return undefined
  return { script: 'unsupported', text: character }
}

const isBlank = (piece: Tagged): boolean =>
  piece.script === 'latin' && piece.text.trim() === ''

// NOTE: The runs of a text, in order. Text is first put in canonical
// composed form, so a letter with an accent is one code point. Adjacent
// characters of one script make one run. A space between two unsupported
// stretches belongs to them, so a sentence in an unsupported script is one
// placeholder, not one per word.
export const splitByScript = (text: string): ReadonlyArray<Piece> => {
  const tagged: Array<Tagged> = []
  for (const character of text.normalize('NFC')) {
    const piece = classify(character)
    if (piece !== undefined) tagged.push(piece)
  }
  const nextScripts: Array<Tagged['script'] | undefined> = []
  let following: Tagged['script'] | undefined
  for (let index = tagged.length - 1; index >= 0; index -= 1) {
    nextScripts[index] = following
    const piece = tagged[index]
    if (piece !== undefined && !isBlank(piece)) following = piece.script
  }
  const merged: Array<Tagged> = []
  tagged.forEach((piece, index) => {
    const last = merged[merged.length - 1]
    const next = { script: nextScripts[index] }
    const bridges =
      isBlank(piece) &&
      last?.script === 'unsupported' &&
      next.script === 'unsupported'
    const script = bridges ? 'unsupported' : piece.script
    if (last !== undefined && last.script === script) {
      merged[merged.length - 1] = { script, text: last.text + piece.text }
    } else {
      merged.push({ script, text: piece.text })
    }
  })
  return merged.map((piece): Piece =>
    piece.script === 'unsupported'
      ? { script: 'latin', text: UNSUPPORTED_PLACEHOLDER }
      : { script: piece.script, text: piece.text },
  )
}

// NOTE: What a text looks like once printed: the runs joined.
export const printedText = (text: string): string =>
  splitByScript(text)
    .map(piece => piece.text)
    .join('')
