import {
  DEFAULT_THEME,
  type DocumentDescription,
  type ItemValue,
  type Person,
  type ReportContent,
  type RichTextDoc,
  type SectionContent,
  type Template,
  type Theme,
  documentDescription,
  redactContent,
} from '@quoroom/domain'
import { fullContent } from '@quoroom/domain/testing/fixtures'

// NOTE: Test support: documents that are long enough to fill pages,
// with invented people, tables, lists, links and images. Everything is
// synthetic.

export const PEOPLE: ReadonlyArray<Person> = [
  {
    id: 'person-1',
    name: 'Mara Velt',
    label: 'Person 1',
    aliases: ['Mara', 'M. Velt', 'Velt'],
  },
  {
    id: 'person-2',
    name: 'Joren Quist',
    label: 'Person 2',
    aliases: ['Joren', 'Quist'],
  },
]

export const CASE = {
  reference: 'IL-2026-0042',
  unit: 'Unit A',
  title: 'Concerns raised about Mara Velt',
}

const SENTENCES = [
  'Mara Velt described the events of the evening to the intake officer.',
  'Joren Quist confirmed that the meeting took place on the date given.',
  'The report was checked against the notes and found consistent.',
  'No further steps were taken before the committee was consulted.',
  'The facts are summarised here without any added assessment.',
  'Velt was asked whether other people had been present at the time.',
  'A synthetic place, a synthetic date and a synthetic sequence of events.',
]

const paragraph = (
  seed: number,
  marks = false,
): RichTextDoc['content'][number] => ({
  type: 'paragraph',
  content: [
    {
      type: 'text',
      text: Array.from(
        { length: 6 },
        (_, index) => SENTENCES[(seed + index) % SENTENCES.length],
      ).join(' '),
    },
    ...(marks
      ? [
          {
            type: 'text' as const,
            text: ' A link to the policy',
            marks: [
              {
                type: 'link' as const,
                attrs: {
                  href: 'https://example.org/policy',
                  target: null,
                  rel: null,
                  class: null,
                },
              },
            ],
          },
          {
            type: 'text' as const,
            text: ' and ',
            marks: [{ type: 'bold' as const }],
          },
          {
            type: 'text' as const,
            text: 'some emphasis.',
            marks: [{ type: 'italic' as const }],
          },
        ]
      : []),
  ],
})

const cell = (
  text: string,
  header = false,
  colwidth?: ReadonlyArray<number>,
) => ({
  type: header ? ('tableHeader' as const) : ('tableCell' as const),
  attrs: {
    colspan: 1,
    rowspan: 1,
    colwidth: colwidth === undefined ? null : [...colwidth],
  },
  content: [
    { type: 'paragraph' as const, content: [{ type: 'text' as const, text }] },
  ],
})

export type BulkOptions = Readonly<{
  // NOTE: Put a figure with this image ID in every rich text.
  imageId?: string
  safeToShare?: boolean
  paragraphs?: number
}>

const bulkDoc = (label: string, options: BulkOptions): RichTextDoc =>
  ({
    type: 'doc',
    content: [
      {
        type: 'heading',
        attrs: { level: 2 },
        content: [{ type: 'text', text: `Notes on ${label}` }],
      },
      ...Array.from({ length: options.paragraphs ?? 7 }, (_, index) =>
        paragraph(index, index === 0),
      ),
      {
        type: 'bulletList',
        content: [0, 1, 2].map(index => ({
          type: 'listItem' as const,
          content: [paragraph(index + 3)],
        })),
      },
      {
        type: 'orderedList',
        attrs: { start: 1 },
        content: [0, 1].map(index => ({
          type: 'listItem' as const,
          content: [paragraph(index + 5)],
        })),
      },
      {
        type: 'table',
        content: [
          {
            type: 'tableRow',
            content: [
              cell('Date', true, [90]),
              cell('Event', true, [260]),
              cell('Source', true, [120]),
            ],
          },
          ...Array.from({ length: 14 }, (_, index) => ({
            type: 'tableRow' as const,
            content: [
              cell(`2026-03-${String(index + 1).padStart(2, '0')}`),
              cell(`Mara Velt met Joren Quist, event ${index + 1}`),
              cell('Interview notes'),
            ],
          })),
        ],
      },
      ...(options.imageId === undefined
        ? []
        : [
            {
              type: 'figure' as const,
              attrs: {
                imageId: options.imageId,
                alt: 'A synthetic picture',
                safeToShare: options.safeToShare ?? true,
              },
              content: [
                {
                  type: 'text' as const,
                  text: 'A synthetic caption of Mara Velt',
                },
              ],
            },
          ]),
    ],
  }) as unknown as RichTextDoc

const mapValue = (
  value: ItemValue,
  label: string,
  options: BulkOptions,
): ItemValue => {
  if (value.type === 'rich_text') {
    return { type: 'rich_text', doc: bulkDoc(label, options) }
  }
  if (value.type === 'text') {
    return { type: 'text', text: `${value.text}, reported by Mara Velt` }
  }
  if (value.type === 'repeated') {
    return {
      type: 'repeated',
      entries: value.entries.map(entry => ({
        ...entry,
        values: mapValues(entry.values, label, options),
      })),
    }
  }
  return value
}

const mapValues = (
  values: SectionContent['values'],
  label: string,
  options: BulkOptions,
): SectionContent['values'] =>
  Object.fromEntries(
    Object.entries(values).map(([id, value]) => [
      id,
      mapValue(value, `${label} ${id}`, options),
    ]),
  )

const mapSection = (
  section: SectionContent,
  label: string,
  options: BulkOptions,
): SectionContent => ({
  ...section,
  values: mapValues(section.values, label, options),
  sections: Object.fromEntries(
    Object.entries(section.sections).map(([id, inner]) => [
      id,
      mapSection(inner, id, options),
    ]),
  ),
  ...(section.entries === undefined
    ? {}
    : {
        entries: section.entries.map(entry => ({
          ...entry,
          values: mapValues(entry.values, label, options),
          sections: Object.fromEntries(
            Object.entries(entry.sections).map(([id, inner]) => [
              id,
              mapSection(inner, id, options),
            ]),
          ),
        })),
      }),
})

export const bulkContent = (
  template: Template,
  options: BulkOptions = {},
): ReportContent => {
  const content = fullContent(template)
  return {
    ...content,
    sections: Object.fromEntries(
      Object.entries(content.sections).map(([id, section]) => [
        id,
        mapSection(section, id, options),
      ]),
    ),
  }
}

export const THEME: Theme = {
  ...DEFAULT_THEME,
  organisationName: 'Quoroom Test Organisation',
  pdf: { header: 'STRICTLY CONFIDENTIAL', footer: 'Page {page} of {pages}' },
}

export const descriptionOf = (
  template: Template,
  options: Readonly<{
    redacted: boolean
    theme?: Theme
    bulk?: BulkOptions
    versionLabel?: string
    date?: string
  }>,
): DocumentDescription => {
  const original = bulkContent(template, options.bulk ?? {})
  const content = options.redacted ? redactContent(PEOPLE, original) : original
  return documentDescription({
    template,
    content,
    view: { kind: options.redacted ? 'redacted' : 'original', people: PEOPLE },
    caseFile: CASE,
    theme: options.theme ?? THEME,
    version: {
      reportName: template.name,
      versionLabel: options.versionLabel ?? 'Revision 2',
      date: options.date ?? '2026-11-12',
    },
    includeConclusion: true,
  })
}

// NOTE: Two tiny JPEGs (1 by 1 pixel, grey) that differ in one quantisation
// byte, so the bytes of one can be searched for inside a PDF and told from the
// other. pdfkit embeds a JPEG as it is.
const TINY_JPEG =
  '/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA='

export const jpegBytes = (variant: 'a' | 'b'): Uint8Array => {
  const bytes = Uint8Array.from(Buffer.from(TINY_JPEG, 'base64'))
  const at = 30
  bytes[at] = variant === 'a' ? 0x10 : 0x23
  return bytes
}

export const jpegDataUri = (variant: 'a' | 'b'): string =>
  `data:image/jpeg;base64,${Buffer.from(jpegBytes(variant)).toString('base64')}`
