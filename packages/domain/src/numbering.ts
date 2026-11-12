import {
  type SectionContent,
  type SectionContents,
  instanceKey,
} from './content'
import { type NumberingLevel, type Section, type Template } from './template'

// NOTE: Numbering as a pure function from a template and its content to the
// numbers shown (D23). It looks at the content only to know how many entries
// each repeatable subsection has. It never looks at a section's status, so
// marking a section *not applicable*, or ending the report early, leaves every
// number unchanged.
//
// Rules:
// - Each level has its own style (`template.numbering[depth - 1]`): arabic,
//   roman or letters, upper or lower case, with a suffix.
// - A section with `numbered: false`, and every front matter section, has no
//   number and does not use one up. Numbering therefore starts at 1 (or A, or
//   I) with the first numbered section after the front matter.
// - Counting restarts under every parent. Under an unnumbered parent the
//   children are numbered by their own level and show no part of the parent.
// - Each entry of a repeatable subsection is a section of its own, with the
//   next number among its siblings, and the title the author gave it.
// - The conclusion section follows the body at the top level.
// - `own` is the number as written at its level (`B.`, `2.`, `a)`); `full`
//   joins the numbers of the numbered ancestors (`II.B.2.a)`).

export const toRoman = (value: number): string => {
  const table: ReadonlyArray<readonly [number, string]> = [
    [1000, 'M'],
    [900, 'CM'],
    [500, 'D'],
    [400, 'CD'],
    [100, 'C'],
    [90, 'XC'],
    [50, 'L'],
    [40, 'XL'],
    [10, 'X'],
    [9, 'IX'],
    [5, 'V'],
    [4, 'IV'],
    [1, 'I'],
  ]
  let rest = value
  let out = ''
  for (const [size, symbol] of table) {
    while (rest >= size) {
      out += symbol
      rest -= size
    }
  }
  return out
}

// NOTE: A, B ... Z, AA, AB ... as in a spreadsheet.
export const toLetters = (value: number): string => {
  let rest = value
  let out = ''
  while (rest > 0) {
    const index = (rest - 1) % 26
    out = String.fromCharCode(65 + index) + out
    rest = Math.floor((rest - 1) / 26)
  }
  return out
}

// NOTE: The number without its suffix, `position` counting from 1.
export const formatNumber = (
  position: number,
  level: NumberingLevel,
): string => {
  const upper =
    level.style === 'roman'
      ? toRoman(position)
      : level.style === 'letters'
        ? toLetters(position)
        : String(position)
  return level.style !== 'arabic' && level.letterCase === 'lower'
    ? upper.toLowerCase()
    : upper
}

// NOTE: The label of a repeated entry: "Allegation 1". `index` counts from 0.
export const entryLabel = (label: string, index: number): string =>
  `${label} ${index + 1}`

export type SectionNumber = Readonly<{ own: string; full: string }>

export type NumberedSection = Readonly<{
  key: string
  parentKey: string
  sectionId: string
  entryId: string | undefined
  // NOTE: 1 for a top-level section.
  depth: number
  frontMatter: boolean
  conclusion: boolean
  // NOTE: The author's title for an entry, otherwise the template's title.
  title: string
  number: SectionNumber | undefined
}>

type Instance = Readonly<{
  entryId: string | undefined
  title: string
  content: Readonly<{ sections: SectionContents }>
}>

const instancesOf = (
  section: Section,
  content: SectionContent | undefined,
): ReadonlyArray<Instance> => {
  if (section.repeat === undefined) {
    return [
      {
        entryId: undefined,
        title: section.title,
        content: content ?? { sections: {} },
      },
    ]
  }
  return (content?.entries ?? []).map(entry => ({
    entryId: entry.id,
    title: entry.title ?? section.title,
    content: entry,
  }))
}

const numberLevel = (
  sections: ReadonlyArray<Section>,
  contents: SectionContents,
  parentKey: string,
  depth: number,
  prefix: ReadonlyArray<string>,
  template: Template,
  conclusionId: string | undefined,
  out: Array<NumberedSection>,
): void => {
  const level = template.numbering[depth - 1]
  let position = 0
  for (const section of sections) {
    const isFront = depth === 1 && section.frontMatter
    for (const instance of instancesOf(section, contents[section.id])) {
      const numbered = section.numbered && !isFront && level !== undefined
      let bare: string | undefined
      let number: SectionNumber | undefined
      if (numbered && level !== undefined) {
        position += 1
        bare = formatNumber(position, level)
        number = {
          own: bare + level.suffix,
          full: [...prefix, bare].join('.') + level.suffix,
        }
      }
      const key = instanceKey(parentKey, section.id, instance.entryId)
      out.push({
        key,
        parentKey,
        sectionId: section.id,
        entryId: instance.entryId,
        depth,
        frontMatter: isFront,
        conclusion: section.id === conclusionId,
        title: instance.title,
        number,
      })
      numberLevel(
        section.sections,
        instance.content.sections,
        key,
        depth + 1,
        bare === undefined ? prefix : [...prefix, bare],
        template,
        conclusionId,
        out,
      )
    }
  }
}

// NOTE: Every section as it is shown, in document order: repeatable sections
// once per entry, with its number.
export const numberSections = (
  template: Template,
  content: Readonly<{ sections: SectionContents }>,
): ReadonlyArray<NumberedSection> => {
  const out: Array<NumberedSection> = []
  const top =
    template.conclusion === undefined
      ? template.sections
      : [...template.sections, template.conclusion]
  numberLevel(
    top,
    content.sections,
    '',
    1,
    [],
    template,
    template.conclusion?.id,
    out,
  )
  return out
}
