import { endState } from './branching'
import {
  type ItemValue,
  type ItemValues,
  type ReportContent,
  type SectionContent,
  type SectionContents,
  instanceKey,
} from './content'
import { entryLabel, numberSections } from './numbering'
import type { Person } from './people'
import { IMAGE_WITHHELD_TEXT } from './redaction'
import type {
  BlockNode,
  InlineNode,
  ListBlock,
  ListItemNode,
  TableNode,
} from './richtext'
import type { Item, Section, Template } from './template'
import type { Theme } from './theme'

// NOTE: The PDF document description (D4, stage 8). A pure function from a
// template, content (the original, or the already redacted content of a
// redacted role), the theme and the version's metadata to a renderer-neutral
// description: parts with blocks. Stage 8 maps it to pdfmake; nothing here
// imports a PDF library, a font file or an image.
//
// - The description is complete without the renderer: headings carry their
//   numbers and a stable ID; the contents lists them to the configured depth
//   without page numbers (the renderer resolves those); header and footer text
//   is split into segments where `{page}` and `{pages}` are left to the
//   renderer and `{case}` and `{title}` are filled in.
// - `{case}` is the case file's reference. `{title}` is the report name of the
//   version metadata, never the case file's title, which may name someone.
// - Every section of the report has a heading, in document order, with the
//   number `numberSections` gives it, also when it is not applicable or ended
//   (numbers never move). The content of such a section is not shown.
// - The conclusion section is shown only if `includeConclusion` says so; by
//   default if the content has anything in it (D23: hidden until concluding).
// - Redaction is the caller's: content and people arrive redacted. As a second
//   line of defence, when `version.redacted` is true a figure that is not
//   marked safe is replaced by the withheld note, and people are shown by
//   their label.
// - Pages: the cover is its own part, then the contents with the front matter
//   sections, then the body. With `continuous` numbering one group counts
//   every page. With `restart_after_front_matter` the cover and the front
//   matter are one group (roman numerals) and the body restarts at 1; `{pages}`
//   is the number of pages of the part's group.
// - Furniture: the template's text overrides the theme's, field by field. If
//   either cover field is set, the cover has its own header and footer (empty
//   where not set) and the others do not apply to it.

export const REDACTION_LABEL = 'Redacted'

// ---- Blocks --------------------------------------------------------------------------

export type Run = Readonly<{
  text: string
  bold?: true
  italic?: true
  underline?: true
  link?: string
}>

export type TableCell = Readonly<{
  header: boolean
  colspan: number
  rowspan: number
  colwidth: ReadonlyArray<number> | undefined
  blocks: ReadonlyArray<Block>
}>

export type ContentsEntry = Readonly<{
  headingId: string
  level: number
  number: string | undefined
  title: string
}>

export type Block =
  | Readonly<{ type: 'logo'; imageId: string }>
  | Readonly<{
      type: 'cover_line'
      emphasis: 'title' | 'subtitle' | 'normal'
      text: string
    }>
  | Readonly<{ type: 'stamp'; text: string }>
  | Readonly<{
      type: 'contents'
      title: string
      entries: ReadonlyArray<ContentsEntry>
    }>
  | Readonly<{
      type: 'heading'
      id: string
      level: number
      number: Readonly<{ own: string; full: string }> | undefined
      title: string
      // NOTE: The heading as shown: the full number, a space, the title.
      text: string
      inContents: boolean
    }>
  | Readonly<{ type: 'rich_heading'; level: number; runs: ReadonlyArray<Run> }>
  | Readonly<{ type: 'paragraph'; runs: ReadonlyArray<Run> }>
  | Readonly<{
      type: 'list'
      ordered: boolean
      start: number
      items: ReadonlyArray<ReadonlyArray<Block>>
    }>
  | Readonly<{ type: 'table'; rows: ReadonlyArray<ReadonlyArray<TableCell>> }>
  | Readonly<{
      type: 'figure'
      imageId: string
      alt: string
      caption: ReadonlyArray<Run>
    }>
  | Readonly<{
      type: 'field'
      label: string
      blocks: ReadonlyArray<Block>
    }>
  | Readonly<{
      type: 'group'
      label: string
      blocks: ReadonlyArray<Block>
    }>
  | Readonly<{
      type: 'signature'
      label: string
      name: string
      date: string | undefined
    }>
  | Readonly<{ type: 'note'; text: string }>

// ---- Description -------------------------------------------------------------------

export type Segment =
  | Readonly<{ kind: 'text'; text: string }>
  | Readonly<{ kind: 'page' }>
  | Readonly<{ kind: 'pages' }>

export type HeaderFooter = Readonly<{
  header: ReadonlyArray<Segment> | undefined
  footer: ReadonlyArray<Segment> | undefined
}>

export type DocumentFurniture = Readonly<{
  normal: HeaderFooter
  // NOTE: Present when the cover page differs.
  cover: HeaderFooter | undefined
}>

export type PartKind = 'cover' | 'front' | 'body'

export type PartNumbering = Readonly<{
  // NOTE: Parts of one group are counted together; `{pages}` is the group's
  // page count.
  group: 'all' | 'front' | 'body'
  style: 'arabic' | 'roman'
  // NOTE: 1 on the first part of a group, otherwise absent (it continues).
  restartAt: 1 | undefined
}>

export type Part = Readonly<{
  kind: PartKind
  numbering: PartNumbering
  blocks: ReadonlyArray<Block>
}>

export type DocumentStyle = Readonly<{
  headingFont: Theme['fonts']['heading']
  bodyFont: Theme['fonts']['body']
  primary: string
  accent: string
  text: string
  background: string
}>

export type DocumentDescription = Readonly<{
  info: Readonly<{
    title: string
    subject: string
    author: string
  }>
  version: VersionMeta
  redactionLabel: string | undefined
  style: DocumentStyle
  furniture: DocumentFurniture
  parts: ReadonlyArray<Part>
  // NOTE: Every image the document uses, the logo included, once each.
  imageIds: ReadonlyArray<string>
}>

export type VersionMeta = Readonly<{
  reportName: string
  // NOTE: For example "Revision 2", "Draft 5" or "Revision 3 (closing)".
  versionLabel: string
  // NOTE: `YYYY-MM-DD`, chosen by the caller (the domain has no clock).
  date: string
  redacted: boolean
}>

export type CaseFileInfo = Readonly<{
  reference: string
  unit: string
  title: string
}>

export type DocumentInput = Readonly<{
  template: Template
  content: ReportContent
  people: ReadonlyArray<Person>
  caseFile: CaseFileInfo
  theme: Theme
  version: VersionMeta
  includeConclusion?: boolean
}>

// ---- Text helpers --------------------------------------------------------------------

const MONTHS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
]

// NOTE: `2026-11-12` as `12 Nov 2026`, `2026-11` as `Nov 2026`. Anything else
// is returned as it is.
export const formatDate = (text: string): string => {
  const match = /^(\d{4})-(\d{2})(?:-(\d{2}))?$/.exec(text)
  const month = match === null ? undefined : MONTHS[Number(match[2]) - 1]
  if (match === null || month === undefined) return text
  return match[3] === undefined
    ? `${month} ${match[1]}`
    : `${Number(match[3])} ${month} ${match[1]}`
}

// NOTE: `2026-11-12 14:05 UTC`, from milliseconds since the epoch.
export const formatInstant = (at: number): string =>
  `${new Date(at).toISOString().slice(0, 16).replace('T', ' ')} UTC`

const TOKEN = /\{(page|pages|case|title)\}/g

export const segmentsOf = (
  text: string,
  values: Readonly<{ case: string; title: string }>,
): ReadonlyArray<Segment> => {
  const out: Array<Segment> = []
  let last = 0
  const push = (value: string): void => {
    if (value === '') return
    const tail = out[out.length - 1]
    if (tail?.kind === 'text') {
      out[out.length - 1] = { kind: 'text', text: tail.text + value }
    } else {
      out.push({ kind: 'text', text: value })
    }
  }
  for (const match of text.matchAll(TOKEN)) {
    push(text.slice(last, match.index))
    last = match.index + match[0].length
    const name = match[1]
    if (name === 'page') out.push({ kind: 'page' })
    else if (name === 'pages') out.push({ kind: 'pages' })
    else push(name === 'case' ? values.case : values.title)
  }
  push(text.slice(last))
  return out
}

export const runsText = (runs: ReadonlyArray<Run>): string =>
  runs.map(run => run.text).join('')

const runsOf = (
  nodes: ReadonlyArray<InlineNode> | undefined,
): ReadonlyArray<Run> =>
  (nodes ?? []).map((node): Run => {
    if (node.type === 'hardBreak') return { text: '\n' }
    const marks = node.marks ?? []
    const link = marks.find(mark => mark.type === 'link')
    return {
      text: node.text,
      ...(marks.some(m => m.type === 'bold') ? { bold: true as const } : {}),
      ...(marks.some(m => m.type === 'italic')
        ? { italic: true as const }
        : {}),
      ...(marks.some(m => m.type === 'underline')
        ? { underline: true as const }
        : {}),
      ...(link?.type === 'link' ? { link: link.attrs.href } : {}),
    }
  })

// ---- Building --------------------------------------------------------------------------

type Context = Readonly<{
  input: DocumentInput
  images: Set<string>
  names: ReadonlyMap<string, string>
}>

const listBlocks = (
  context: Context,
  blocks: ReadonlyArray<ListBlock | BlockNode>,
): ReadonlyArray<Block> => blocks.flatMap(block => richBlock(context, block))

const listItems = (
  context: Context,
  items: ReadonlyArray<ListItemNode>,
): ReadonlyArray<ReadonlyArray<Block>> =>
  items.map(item => listBlocks(context, item.content))

const tableBlock = (context: Context, table: TableNode): Block => ({
  type: 'table',
  rows: table.content.map(row =>
    row.content.map((cell): TableCell => ({
      header: cell.type === 'tableHeader',
      colspan: cell.attrs?.colspan ?? 1,
      rowspan: cell.attrs?.rowspan ?? 1,
      colwidth: cell.attrs?.colwidth ?? undefined,
      blocks: listBlocks(context, cell.content),
    })),
  ),
})

const richBlock = (
  context: Context,
  block: BlockNode | ListBlock,
): ReadonlyArray<Block> => {
  switch (block.type) {
    case 'paragraph':
      return [{ type: 'paragraph', runs: runsOf(block.content) }]
    case 'heading':
      return [
        {
          type: 'rich_heading',
          level: block.attrs.level,
          runs: runsOf(block.content),
        },
      ]
    case 'bulletList':
      return [
        {
          type: 'list',
          ordered: false,
          start: 1,
          items: listItems(context, block.content),
        },
      ]
    case 'orderedList':
      return [
        {
          type: 'list',
          ordered: true,
          start: block.attrs?.start ?? 1,
          items: listItems(context, block.content),
        },
      ]
    case 'table':
      return [tableBlock(context, block)]
    case 'figure':
      if (context.input.version.redacted && !block.attrs.safeToShare) {
        return [
          {
            type: 'paragraph',
            runs: [{ text: IMAGE_WITHHELD_TEXT, italic: true }],
          },
        ]
      }
      context.images.add(block.attrs.imageId)
      return [
        {
          type: 'figure',
          imageId: block.attrs.imageId,
          alt: block.attrs.alt,
          caption: runsOf(block.content),
        },
      ]
  }
}

const plain = (text: string): ReadonlyArray<Block> =>
  text.trim() === '' ? [] : [{ type: 'paragraph', runs: [{ text }] }]

const richPlainText = (blocks: ReadonlyArray<Block>): string => {
  const parts: Array<string> = []
  const visit = (block: Block): void => {
    if (block.type === 'paragraph' || block.type === 'rich_heading') {
      parts.push(runsText(block.runs))
    } else if (block.type === 'list') {
      block.items.forEach(item => item.forEach(visit))
    }
  }
  blocks.forEach(visit)
  return parts.join(' ')
}

const nameOf = (context: Context, personId: string): string =>
  context.names.get(personId) ?? personId

const valueBlocks = (
  context: Context,
  item: Item,
  value: ItemValue | undefined,
): ReadonlyArray<Block> => {
  if (item.type === 'case_value') {
    const { caseFile } = context.input
    return plain(caseFile[item.field])
  }
  if (item.type === 'signature') {
    const signed = value?.type === 'signature' ? value : undefined
    return [
      {
        type: 'signature',
        label: item.label,
        name: signed?.name ?? '',
        date: signed?.date === undefined ? undefined : formatDate(signed.date),
      },
    ]
  }
  if (value === undefined) return []
  if (value.type === 'not_applicable') {
    return [{ type: 'note', text: `Not applicable: ${value.reason}` }]
  }
  if (value.type === 'text' && item.type === 'text') return plain(value.text)
  if (value.type === 'date') return plain(formatDate(value.date))
  if (value.type === 'select' && item.type === 'select') {
    const labels = value.optionIds.flatMap(id => {
      const option = item.options.find(candidate => candidate.id === id)
      return option === undefined
        ? []
        : [
            option.code === undefined
              ? option.label
              : `${option.code}: ${option.label}`,
          ]
    })
    return plain(labels.join(', '))
  }
  if (value.type === 'people') {
    return plain(value.personIds.map(id => nameOf(context, id)).join(', '))
  }
  if (value.type === 'rich_text') {
    return listBlocks(context, value.doc.content)
  }
  return []
}

const itemBlocks = (
  context: Context,
  item: Item,
  values: ItemValues,
): ReadonlyArray<Block> => {
  const value = values[item.id]
  if (item.type === 'repeated') {
    if (value?.type !== 'repeated') return []
    return value.entries.map((entry, index): Block => ({
      type: 'group',
      label:
        entry.title === undefined
          ? entryLabel(item.entryLabel, index)
          : `${entryLabel(item.entryLabel, index)}: ${entry.title}`,
      blocks: item.items.flatMap(child =>
        itemBlocks(context, child, entry.values),
      ),
    }))
  }
  const blocks = valueBlocks(context, item, value)
  if (blocks.length === 0) return []
  return item.type === 'signature'
    ? blocks
    : [{ type: 'field', label: item.label, blocks }]
}

type Instance = Readonly<{
  entryId: string | undefined
  values: ItemValues
  sections: SectionContents
  notApplicable: SectionContent['notApplicable']
}>

const instancesOf = (
  section: Section,
  content: SectionContent | undefined,
): ReadonlyArray<Instance> =>
  section.repeat === undefined
    ? [
        {
          entryId: undefined,
          values: content?.values ?? {},
          sections: content?.sections ?? {},
          notApplicable: content?.notApplicable,
        },
      ]
    : (content?.entries ?? []).map(entry => ({
        entryId: entry.id,
        values: entry.values,
        sections: entry.sections,
        notApplicable: undefined,
      }))

type Suppression = 'not_applicable' | 'ended' | undefined

const sectionBlocks = (
  context: Context,
  numbers: ReadonlyMap<string, ReturnType<typeof numberSections>[number]>,
  ended: ReadonlySet<string>,
  triggerSections: ReadonlySet<string>,
  outcome: string | undefined,
  section: Section,
  content: SectionContent | undefined,
  parentKey: string,
  depth: number,
  inherited: Suppression,
): ReadonlyArray<Block> => {
  const contentsDepth = context.input.template.contentsDepth
  const out: Array<Block> = []
  for (const instance of instancesOf(section, content)) {
    const key = instanceKey(parentKey, section.id, instance.entryId)
    const numbered = numbers.get(key)
    const title = numbered?.title ?? section.title
    const number = numbered?.number
    out.push({
      type: 'heading',
      id: key,
      level: depth,
      number,
      title,
      text: number === undefined ? title : `${number.full} ${title}`,
      inContents: contentsDepth !== undefined && depth <= contentsDepth,
    })
    const suppression: Suppression =
      inherited ??
      (instance.notApplicable !== undefined
        ? 'not_applicable'
        : ended.has(section.id)
          ? 'ended'
          : undefined)
    if (suppression === 'not_applicable') {
      out.push({
        type: 'note',
        text:
          instance.notApplicable === undefined
            ? 'Not applicable'
            : `Not applicable: ${instance.notApplicable.reason}`,
      })
    } else if (suppression === 'ended') {
      out.push({ type: 'note', text: 'Not applicable (ended)' })
    } else {
      for (const item of section.items) {
        out.push(...itemBlocks(context, item, instance.values))
      }
      if (outcome !== undefined && triggerSections.has(section.id)) {
        out.push({ type: 'note', text: outcome })
      }
    }
    for (const child of section.sections) {
      out.push(
        ...sectionBlocks(
          context,
          numbers,
          ended,
          triggerSections,
          outcome,
          child,
          instance.sections[child.id],
          key,
          depth + 1,
          suppression,
        ),
      )
    }
  }
  return out
}

// ---- Cover ----------------------------------------------------------------------------

// NOTE: The text value of an item the cover may show (text, date or select, in
// a section of the body that is not repeated), found by its ID.
const coverItemText = (
  context: Context,
  itemId: string,
): string | undefined => {
  const { template, content } = context.input
  const find = (
    sections: ReadonlyArray<Section>,
    contents: SectionContents,
  ): string | undefined => {
    for (const section of sections) {
      if (section.repeat !== undefined) continue
      const sectionContent = contents[section.id]
      const item = section.items.find(candidate => candidate.id === itemId)
      if (item !== undefined) {
        return richPlainText(
          valueBlocks(context, item, sectionContent?.values[item.id]),
        )
      }
      const inner = find(section.sections, sectionContent?.sections ?? {})
      if (inner !== undefined) return inner
    }
    return undefined
  }
  return find(template.sections, content.sections)
}

const coverBlocks = (context: Context): ReadonlyArray<Block> => {
  const { template, caseFile, theme, version } = context.input
  const out: Array<Block> = []
  if (theme.logo !== undefined) {
    context.images.add(theme.logo)
    out.push({ type: 'logo', imageId: theme.logo })
  }
  out.push({
    type: 'cover_line',
    emphasis: 'normal',
    text: theme.organisationName,
  })
  if (template.cover === undefined) {
    out.push({
      type: 'cover_line',
      emphasis: 'title',
      text: version.reportName,
    })
    out.push({
      type: 'cover_line',
      emphasis: 'normal',
      text: `${template.caseReferenceLabel}: ${caseFile.reference}`,
    })
  } else {
    for (const line of template.cover.lines) {
      const pieces = line.parts.map(part =>
        part.kind === 'text'
          ? part.text
          : part.kind === 'case_value'
            ? caseFile[part.field]
            : (coverItemText(context, part.itemId) ?? ''),
      )
      // NOTE: A line made of values is left out when none of them has one, so
      // fixed words such as "in" never stand alone.
      const valued = line.parts.some(
        (part, index) =>
          part.kind !== 'text' && (pieces[index] ?? '').trim() !== '',
      )
      const onlyText = line.parts.every(part => part.kind === 'text')
      const text =
        valued || onlyText
          ? pieces.filter(piece => piece.trim() !== '').join(' ')
          : ''
      if (text !== '') {
        out.push({ type: 'cover_line', emphasis: line.emphasis, text })
      }
    }
  }
  out.push({
    type: 'cover_line',
    emphasis: 'subtitle',
    text: `${version.reportName} - ${version.versionLabel}`,
  })
  out.push({
    type: 'cover_line',
    emphasis: 'normal',
    text: formatDate(version.date),
  })
  if (version.redacted) out.push({ type: 'stamp', text: REDACTION_LABEL })
  return out
}

// ---- Furniture and parts ------------------------------------------------------------------

export const furnitureOf = (
  template: Template | undefined,
  theme: Theme,
  values: Readonly<{ case: string; title: string }>,
): DocumentFurniture => {
  const pick = (
    field: 'header' | 'footer' | 'coverHeader' | 'coverFooter',
  ): ReadonlyArray<Segment> | undefined => {
    const text = template?.furniture[field] ?? theme.pdf[field]
    return text === undefined ? undefined : segmentsOf(text, values)
  }
  const coverHeader = pick('coverHeader')
  const coverFooter = pick('coverFooter')
  return {
    normal: { header: pick('header'), footer: pick('footer') },
    cover:
      coverHeader === undefined && coverFooter === undefined
        ? undefined
        : { header: coverHeader, footer: coverFooter },
  }
}

export const styleOf = (theme: Theme): DocumentStyle => ({
  headingFont: theme.fonts.heading,
  bodyFont: theme.fonts.body,
  primary: theme.colors.primary,
  accent: theme.colors.accent,
  text: theme.colors.text,
  background: theme.colors.background,
})

const partsOf = (
  mode: Template['pageNumbering'],
  cover: ReadonlyArray<Block>,
  front: ReadonlyArray<Block>,
  body: ReadonlyArray<Block>,
): ReadonlyArray<Part> => {
  const restart = mode === 'restart_after_front_matter'
  const frontNumbering = (first: boolean): PartNumbering => ({
    group: restart ? 'front' : 'all',
    style: restart ? 'roman' : 'arabic',
    restartAt: first ? 1 : undefined,
  })
  const parts: Array<Part> = [
    { kind: 'cover', numbering: frontNumbering(true), blocks: cover },
  ]
  if (front.length > 0) {
    parts.push({
      kind: 'front',
      numbering: frontNumbering(false),
      blocks: front,
    })
  }
  if (body.length > 0) {
    parts.push({
      kind: 'body',
      numbering: restart
        ? { group: 'body', style: 'arabic', restartAt: 1 }
        : { group: 'all', style: 'arabic', restartAt: undefined },
      blocks: body,
    })
  }
  return parts
}

const hasContent = (section: SectionContent | undefined): boolean =>
  section !== undefined &&
  (Object.keys(section.values).length > 0 ||
    Object.keys(section.sections).length > 0 ||
    (section.entries?.length ?? 0) > 0 ||
    section.notApplicable !== undefined)

export const documentDescription = (
  input: DocumentInput,
): DocumentDescription => {
  const { template, content, people, theme, version, caseFile } = input
  const names = new Map(
    people.map(person => [
      person.id,
      version.redacted ? person.label : person.name,
    ]),
  )
  const context: Context = { input, images: new Set(), names }
  const numbers = new Map(
    numberSections(template, content).map(entry => [entry.key, entry]),
  )
  const end = endState(template, content)
  const triggerSections = new Set(end.triggers.map(t => t.sectionId))
  const conclusion = template.conclusion
  const includeConclusion =
    input.includeConclusion ??
    (conclusion !== undefined && hasContent(content.sections[conclusion.id]))
  const top =
    conclusion !== undefined && includeConclusion
      ? [...template.sections, conclusion]
      : template.sections

  const cover = coverBlocks(context)
  const frontSections: Array<Block> = []
  const body: Array<Block> = []
  for (const section of top) {
    const blocks = sectionBlocks(
      context,
      numbers,
      end.endedSectionIds,
      triggerSections,
      end.outcomeText,
      section,
      content.sections[section.id],
      '',
      1,
      undefined,
    )
    ;(section.frontMatter ? frontSections : body).push(...blocks)
  }
  const headings = [...frontSections, ...body].flatMap(block =>
    block.type === 'heading' && block.inContents ? [block] : [],
  )
  const front: Array<Block> =
    template.contentsDepth === undefined
      ? frontSections
      : [
          {
            type: 'contents',
            title: 'Contents',
            entries: headings.map(heading => ({
              headingId: heading.id,
              level: heading.level,
              number: heading.number?.full,
              title: heading.title,
            })),
          },
          ...frontSections,
        ]
  const values = { case: caseFile.reference, title: version.reportName }
  return {
    info: {
      title: `${version.reportName} - ${version.versionLabel}`,
      subject: caseFile.reference,
      author: theme.organisationName,
    },
    version,
    redactionLabel: version.redacted ? REDACTION_LABEL : undefined,
    style: styleOf(theme),
    furniture: furnitureOf(template, theme, values),
    parts: partsOf(template.pageNumbering, cover, front, body),
    imageIds: [...context.images],
  }
}

// ---- Walking a description ---------------------------------------------------------------

// NOTE: Every block of a description, nested ones included, in order.
export const allBlocks = (
  description: Pick<DocumentDescription, 'parts'>,
): ReadonlyArray<Block> => {
  const out: Array<Block> = []
  const visit = (block: Block): void => {
    out.push(block)
    if (block.type === 'list') {
      block.items.forEach(item => item.forEach(visit))
    } else if (block.type === 'table') {
      block.rows.forEach(row => row.forEach(cell => cell.blocks.forEach(visit)))
    } else if (block.type === 'field' || block.type === 'group') {
      block.blocks.forEach(visit)
    }
  }
  description.parts.forEach(part => part.blocks.forEach(visit))
  return out
}

export const headingsOf = (
  description: Pick<DocumentDescription, 'parts'>,
): ReadonlyArray<Extract<Block, { type: 'heading' }>> =>
  allBlocks(description).flatMap(block =>
    block.type === 'heading' ? [block] : [],
  )

// NOTE: Every string the document will print, for checks that look for text
// (an alias, an image ID) in everything a renderer can show.
export const documentStrings = (
  description: DocumentDescription,
): ReadonlyArray<string> => {
  const out: Array<string> = [
    description.info.title,
    description.info.subject,
    description.info.author,
    description.version.reportName,
    description.version.versionLabel,
  ]
  const segments = (parts: ReadonlyArray<Segment> | undefined): void => {
    parts?.forEach(segment => {
      if (segment.kind === 'text') out.push(segment.text)
    })
  }
  for (const group of [
    description.furniture.normal,
    description.furniture.cover,
  ]) {
    segments(group?.header)
    segments(group?.footer)
  }
  for (const block of allBlocks(description)) {
    switch (block.type) {
      case 'cover_line':
      case 'stamp':
      case 'note':
        out.push(block.text)
        break
      case 'heading':
        out.push(block.text, block.title)
        break
      case 'paragraph':
      case 'rich_heading':
        out.push(...block.runs.map(run => run.text))
        break
      case 'figure':
        out.push(block.alt, ...block.caption.map(run => run.text))
        break
      case 'field':
      case 'group':
        out.push(block.label)
        break
      case 'signature':
        out.push(block.label, block.name)
        break
      case 'contents':
        out.push(block.title, ...block.entries.map(entry => entry.title))
        break
      default:
        break
    }
  }
  return out
}
