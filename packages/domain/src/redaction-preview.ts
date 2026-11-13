import {
  CONTENT_SCHEMA_VERSION,
  type ReportContent,
  type SectionContent,
} from './content'
import type { Person } from './people'
import { IMAGE_WITHHELD_TEXT, redactorFor } from './redaction'
import type { Template } from './template'

// NOTE: What the server stores when a section is shared and what the author's
// browser shows as the preview are the same function of the same inputs, so
// the preview is exactly the text that is shared (D14). The server computes
// it in `ShareSection`; the browser computes it from the working copy and
// compares the hash of the result with the one the server returns before the
// author's confirmation is sent.

const EMPTY_SECTION: SectionContent = { values: {}, sections: {} }

// NOTE: JSON with the keys of every object in sorted order, so two equal
// values give the same text whatever order their keys were built in (a
// section decoded by a schema in the browser, one parsed from storage on the
// server). The hash of a redacted section is the hash of this text.
export const canonicalJson = (value: unknown): string =>
  JSON.stringify(value, (_key, inner: unknown) =>
    typeof inner === 'object' && inner !== null && !Array.isArray(inner)
      ? Object.fromEntries(
          Object.entries(inner as Record<string, unknown>).sort(([a], [b]) =>
            a < b ? -1 : a > b ? 1 : 0,
          ),
        )
      : inner,
  )

export const shellOf = (
  template: Template,
  sections: Readonly<Record<string, SectionContent>>,
): ReportContent => ({
  schemaVersion: CONTENT_SCHEMA_VERSION,
  templateId: template.id,
  templateVersion: template.version,
  sections,
})

// NOTE: One top-level section as a redacted role reads it. Images not marked
// safe are withheld, every alias is replaced by its label.
export const redactedSectionOf = (
  template: Template,
  people: ReadonlyArray<Person>,
  sectionId: string,
  section: SectionContent,
): SectionContent =>
  redactorFor(people).content(shellOf(template, { [sectionId]: section }))
    .sections[sectionId] ?? EMPTY_SECTION

// NOTE: The strings the preview marks: the label of every person and the
// placeholder of a withheld image. The labels never match an alias of the list
// (`peopleListProblems`), so what is marked was put there by redaction, or was
// written that way by the author, which is harmless to mark.
export const highlightedTexts = (
  people: ReadonlyArray<Person>,
): ReadonlyArray<string> => [
  IMAGE_WITHHELD_TEXT,
  ...people
    .map(person => person.label)
    .filter(label => label !== '')
    .sort((a, b) => b.length - a.length),
]

export type TextPart = Readonly<{ text: string; marked: boolean }>

// NOTE: A text cut into the parts that are marked and the parts that are not,
// by the longest string first and without regard to case.
export const markedParts = (
  text: string,
  marks: ReadonlyArray<string>,
): ReadonlyArray<TextPart> => {
  if (marks.length === 0 || text === '') {
    return [{ text, marked: false }]
  }
  const lower = text.toLowerCase()
  const candidates = marks
    .filter(mark => mark !== '')
    .map(mark => mark.toLowerCase())
  const parts: Array<TextPart> = []
  let plainFrom = 0
  let at = 0
  while (at < text.length) {
    let found = ''
    for (const mark of candidates) {
      if (
        mark.length > found.length &&
        lower.startsWith(mark, at) &&
        lower.length === text.length
      ) {
        found = mark
      }
    }
    if (found === '') {
      at += 1
      continue
    }
    if (at > plainFrom) {
      parts.push({ text: text.slice(plainFrom, at), marked: false })
    }
    parts.push({ text: text.slice(at, at + found.length), marked: true })
    at += found.length
    plainFrom = at
  }
  if (plainFrom < text.length) {
    parts.push({ text: text.slice(plainFrom), marked: false })
  }
  return parts
}
