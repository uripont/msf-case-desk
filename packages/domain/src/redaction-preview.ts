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

// NOTE: The case file as a redacted reader sees it: the title and the
// reference, redacted with the people list. The confirmation of a share covers
// the canonical JSON of this (D14), so a title changed after the preview is not
// the share the author saw. The server and the browser both make it here.
export const redactedCaseOf = (
  people: ReadonlyArray<Person>,
  title: string,
  reference: string,
): Readonly<{ title: string; reference: string }> => {
  const redactor = redactorFor(people)
  return { title: redactor.text(title), reference: redactor.text(reference) }
}

export type TextPart = Readonly<{ text: string; marked: boolean }>

// NOTE: A text cut into the parts that are marked and the parts that are not,
// by the longest string first and without regard to case. Lowercasing can
// change the length of a character ("\u0130"), so the search runs on a
// lowercased copy built one character at a time, with the range of the
// original each lowered unit came from; the parts are cut from the original.
export const markedParts = (
  text: string,
  marks: ReadonlyArray<string>,
): ReadonlyArray<TextPart> => {
  if (marks.length === 0 || text === '') {
    return [{ text, marked: false }]
  }
  let lower = ''
  const origStart: Array<number> = []
  const origEnd: Array<number> = []
  let index = 0
  for (const ch of text) {
    const low = ch.toLowerCase()
    for (let i = 0; i < low.length; i++) {
      origStart.push(index)
      origEnd.push(index + ch.length)
    }
    lower += low
    index += ch.length
  }
  const candidates = marks
    .filter(mark => mark !== '')
    .map(mark => mark.toLowerCase())
  const parts: Array<TextPart> = []
  let plainFrom = 0
  let at = 0
  while (at < lower.length) {
    let found = ''
    for (const mark of candidates) {
      if (mark.length > found.length && lower.startsWith(mark, at)) {
        found = mark
      }
    }
    const start = origStart[at] as number
    if (found === '' || start < plainFrom) {
      at += 1
      continue
    }
    const end = origEnd[at + found.length - 1] as number
    if (start > plainFrom) {
      parts.push({ text: text.slice(plainFrom, start), marked: false })
    }
    parts.push({ text: text.slice(start, end), marked: true })
    at += found.length
    plainFrom = end
  }
  if (plainFrom < text.length) {
    parts.push({ text: text.slice(plainFrom), marked: false })
  }
  return parts
}
