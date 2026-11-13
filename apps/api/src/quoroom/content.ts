import {
  CONTENT_SCHEMA_VERSION,
  type ItemValue,
  type ItemValues,
  type ReportContent,
  type RichTextDoc,
  type SectionContent,
  type SectionEntry,
  type Template,
  richTextFigures,
} from '@case-desk/domain'

// NOTE: Helpers that look inside stored section content: the images a section
// references, rewriting every rich text document, and the hash of a text.
// Section content is stored as the JSON of a `SectionContent`, one row per
// top-level section; it is validated when written, so reading it is a
// `JSON.parse` and nothing else.

export const EMPTY_SECTION: SectionContent = { values: {}, sections: {} }

export const parseSection = (text: string): SectionContent =>
  JSON.parse(text) as SectionContent

// NOTE: the IDs of the sections a report is stored by (the top-level sections
// of the template, then the conclusion), in template order.
export const topLevelIds = (template: Template): ReadonlyArray<string> => [
  ...template.sections.map(section => section.id),
  ...(template.conclusion === undefined ? [] : [template.conclusion.id]),
]

export const ordinalOf = (template: Template, sectionId: string): number =>
  topLevelIds(template).indexOf(sectionId)

export const reportShell = (
  template: Template,
  sections: Readonly<Record<string, SectionContent>>,
): ReportContent => ({
  schemaVersion: CONTENT_SCHEMA_VERSION,
  templateId: template.id,
  templateVersion: template.version,
  sections,
})

const mapValues = (
  values: ItemValues,
  f: (doc: RichTextDoc) => RichTextDoc,
): ItemValues =>
  Object.fromEntries(
    Object.entries(values).map(([id, value]): [string, ItemValue] => [
      id,
      mapValue(value, f),
    ]),
  )

const mapValue = (
  value: ItemValue,
  f: (doc: RichTextDoc) => RichTextDoc,
): ItemValue => {
  if (value.type === 'rich_text') return { ...value, doc: f(value.doc) }
  if (value.type === 'repeated') {
    return {
      ...value,
      entries: value.entries.map(entry => ({
        ...entry,
        values: mapValues(entry.values, f),
      })),
    }
  }
  return value
}

const mapSections = (
  sections: SectionContent['sections'],
  f: (doc: RichTextDoc) => RichTextDoc,
): SectionContent['sections'] =>
  Object.fromEntries(
    Object.entries(sections).map(([id, section]) => [
      id,
      mapSectionDocs(section, f),
    ]),
  )

// NOTE: the section with every rich text document of its items, entries and
// subsections replaced by `f(doc)`.
export const mapSectionDocs = (
  section: SectionContent,
  f: (doc: RichTextDoc) => RichTextDoc,
): SectionContent => ({
  ...section,
  values: mapValues(section.values, f),
  sections: mapSections(section.sections, f),
  ...(section.entries === undefined
    ? {}
    : {
        entries: section.entries.map(
          (entry): SectionEntry => ({
            ...entry,
            values: mapValues(entry.values, f),
            sections: mapSections(entry.sections, f),
          }),
        ),
      }),
})

export type Figure = Readonly<{ imageId: string; safe: boolean }>

// NOTE: every image a section references, with the flag of each figure.
export const sectionFigures = (
  section: SectionContent,
): ReadonlyArray<Figure> => {
  const found: Array<Figure> = []
  mapSectionDocs(section, doc => {
    for (const attrs of richTextFigures(doc)) {
      found.push({ imageId: attrs.imageId, safe: attrs.safeToShare })
    }
    return doc
  })
  return found
}

// NOTE: JSON `[{ "id": "...", "safe": true }]`, one entry per image, safe only
// if every figure of it in the section is (the staging format of the
// repository).
export const imageRefsJson = (section: SectionContent): string => {
  const flags = new Map<string, boolean>()
  for (const figure of sectionFigures(section)) {
    flags.set(figure.imageId, (flags.get(figure.imageId) ?? true) && figure.safe)
  }
  return JSON.stringify(
    [...flags].map(([id, safe]) => ({ id, safe })),
  )
}

const toHex = (bytes: ArrayBuffer): string =>
  Array.from(new Uint8Array(bytes), byte =>
    byte.toString(16).padStart(2, '0'),
  ).join('')

export const sha256Hex = async (text: string): Promise<string> =>
  toHex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))

export const utf8Length = (text: string): number =>
  new TextEncoder().encode(text).length

// NOTE: the native `toBase64` where the runtime has it (workerd does), and a
// chunked `btoa` otherwise (older Node, which only the tests use).
export const bytesToBase64 = (bytes: Uint8Array): string => {
  const native = (bytes as Uint8Array & { toBase64?: () => string }).toBase64
  if (native !== undefined) return native.call(bytes)
  let binary = ''
  for (let at = 0; at < bytes.length; at += 8192) {
    binary += String.fromCharCode(...bytes.subarray(at, at + 8192))
  }
  return btoa(binary)
}
