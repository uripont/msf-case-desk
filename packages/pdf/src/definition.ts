import type {
  Block,
  ContentsEntry,
  DocumentDescription,
  FontFamily,
  HeaderFooter,
  Part,
  Run,
  Segment,
  TableCell,
} from '@quoroom/domain'
import { MIN_TEXT_CONTRAST, contrastRatio, toRoman } from '@quoroom/domain'

import { type FontDefinition, definitionOf, fontName } from './fonts'
import { type Script, splitByScript } from './scripts'

// NOTE: The pure mapping from the document description of `packages/domain`
// to a pdfmake document definition (D4). It has no PDF library, no
// font file and no image in it: fonts are named (`fonts`, `fontFiles`) and the
// images arrive as data URIs, both supplied by an adapter (the browser's or
// Node's), so the same function runs in both and the same text comes out.
//
// Layout in short:
// - one pdfmake `section` per part (cover, front matter, body), so each starts
//   on a new page; the page of each part is recorded while pdfmake lays the
//   pages out (the `background` function of a section is called for every page
//   it adds), and header and footer, which pdfmake runs afterwards, use it to
//   print `{page}` and `{pages}` per numbering group (front matter in roman
//   numerals and the body restarting at 1, or one count);
// - the table of contents is drawn here, not by pdfmake, because its page
//   numbers must follow the same restart. Rendering is done twice when there
//   is a contents: the first pass learns the page of every heading, the second
//   prints them in a column of fixed width, so the layout does not change.

type PdfNode = Record<string, unknown>

export const PAGE_WIDTH = 595.28
export const PAGE_HEIGHT = 841.89
const MARGIN_X = 56
const CONTENT_WIDTH = PAGE_WIDTH - 2 * MARGIN_X
const GROUP_INDENT = 12
const LIST_INDENT = 16
const CELL_PADDING = 4
const LABEL_COLUMN = 40

export type PdfImages = ReadonlyMap<string, string>

export type Measured = Readonly<{
  partOfPage: ReadonlyArray<number>
  headingPages: ReadonlyMap<string, number>
}>

export type PdfBuild = Readonly<{
  definition: PdfNode
  fonts: Readonly<Record<string, FontDefinition>>
  fontFiles: ReadonlyArray<string>
  hasContents: boolean
  // NOTE: What the layout showed; valid after the definition was rendered.
  measured: () => Measured
}>

// ---- Numbers -------------------------------------------------------------------------

const lowerRoman = (value: number): string =>
  toRoman(Math.max(1, Math.floor(value))).toLowerCase()

const formatNumber = (value: number, style: 'arabic' | 'roman'): string =>
  style === 'roman' ? lowerRoman(value) : String(value)

// ---- Colours ---------------------------------------------------------------------------

const mix = (hex: string, other: string, share: number): string => {
  const channel = (colour: string, at: number): number =>
    Number.parseInt(colour.slice(at, at + 2), 16)
  const part = (at: number): string =>
    Math.round(channel(hex, at) * (1 - share) + channel(other, at) * share)
      .toString(16)
      .padStart(2, '0')
  return `#${part(1)}${part(3)}${part(5)}`
}

// NOTE: Colours derived from the theme must stay readable on what they sit
// on, for any theme that passes `themeProblems` (text, primary and accent each
// at least 4.5:1 on the background). A derived colour is a mix toward the
// background; the share is raised (fills) or lowered (text) until every pair
// passes, and the end of the search is a colour the theme itself guarantees:
// the background for a fill, the text colour for text.
const readableOn = (
  colour: string,
  against: ReadonlyArray<string>,
): boolean =>
  against.every(other => contrastRatio(colour, other) >= MIN_TEXT_CONTRAST)

const steps = (from: number, to: number, by: number): ReadonlyArray<number> =>
  Array.from(
    { length: Math.floor(Math.abs(to - from) / by + 1e-9) + 1 },
    (_, index) => from + Math.sign(to - from) * by * index,
  )

const fillFor = (
  base: string,
  background: string,
  startShare: number,
  texts: ReadonlyArray<string>,
): string =>
  steps(startShare, 1, 0.02)
    .map(share => mix(base, background, Math.min(1, share)))
    .concat(background)
    .find(candidate => readableOn(candidate, texts)) ?? background

const textFor = (
  text: string,
  background: string,
  startShare: number,
): string =>
  steps(startShare, 0, 0.05)
    .map(share => mix(text, background, Math.max(0, share)))
    .find(candidate => readableOn(candidate, [background])) ?? text

export const derivedColours = (
  look: DocumentDescription['style'],
): Readonly<{ tableHeaderFill: string; furniture: string; rule: string }> => ({
  tableHeaderFill: fillFor(look.primary, look.background, 0.88, [
    look.text,
    look.primary,
    look.accent,
  ]),
  furniture: textFor(look.text, look.background, 0.25),
  rule: mix(look.text, look.background, 0.75),
})

// ---- The build ------------------------------------------------------------------------------

type TextStyle = Readonly<{
  family: FontFamily
  bold?: boolean
  italics?: boolean
  underline?: boolean
  link?: string
  color?: string
}>

type Geometry = Readonly<{
  pageCount: number
  labels: ReadonlyArray<string>
  totals: ReadonlyArray<string>
  partOfPage: ReadonlyArray<number>
}>

const geometryOf = (
  parts: ReadonlyArray<Part>,
  partOfPage: ReadonlyArray<number>,
): Geometry => {
  const seen = new Map<string, number>()
  const counts = new Map<string, number>()
  partOfPage.forEach(index => {
    const group = parts[index]?.numbering.group ?? 'all'
    counts.set(group, (counts.get(group) ?? 0) + 1)
  })
  const labels: Array<string> = []
  const totals: Array<string> = []
  partOfPage.forEach(index => {
    const numbering = parts[index]?.numbering
    const group = numbering?.group ?? 'all'
    const style = numbering?.style ?? 'arabic'
    const position = (seen.get(group) ?? 0) + 1
    seen.set(group, position)
    labels.push(formatNumber(position, style))
    totals.push(formatNumber(counts.get(group) ?? position, style))
  })
  return { pageCount: partOfPage.length, labels, totals, partOfPage }
}

export const buildPdf = (
  description: DocumentDescription,
  images: PdfImages,
  measured?: Measured,
): PdfBuild => {
  const { style: look, parts } = description
  const used = new Map<string, FontDefinition>()
  const registerFont = (family: FontFamily, script: Script): string => {
    const name = fontName(family, script)
    if (!used.has(name)) used.set(name, definitionOf(family, script))
    return name
  }
  registerFont(look.bodyFont, 'latin')
  registerFont(look.headingFont, 'latin')

  const derived = derivedColours(look)

  const inlines = (text: string, style: TextStyle): ReadonlyArray<PdfNode> =>
    splitByScript(text).map((piece): PdfNode => ({
      text: piece.text,
      font: registerFont(style.family, piece.script),
      ...(style.bold === true ? { bold: true } : {}),
      ...(style.italics === true ? { italics: true } : {}),
      ...(style.underline === true ? { decoration: 'underline' } : {}),
      ...(style.link === undefined ? {} : { link: style.link }),
      ...(style.color === undefined ? {} : { color: style.color }),
    }))

  const runInlines = (
    runs: ReadonlyArray<Run>,
    base: TextStyle,
  ): ReadonlyArray<PdfNode> =>
    runs.flatMap(run =>
      inlines(run.text, {
        ...base,
        ...(run.bold === true ? { bold: true } : {}),
        ...(run.italic === true ? { italics: true } : {}),
        ...(run.underline === true ? { underline: true } : {}),
        ...(run.link === undefined
          ? {}
          : { link: run.link, underline: true, color: look.primary }),
      }),
    )

  const body: TextStyle = { family: look.bodyFont }
  const heading: TextStyle = { family: look.headingFont, bold: true }

  // ---- Page recording ------------------------------------------------------------------

  let partOfPage: Array<number> = []
  const headingPages = new Map<string, number>()
  let geometry: Geometry | undefined
  const geometryNow = (): Geometry => {
    geometry ??= geometryOf(parts, partOfPage)
    return geometry
  }

  // ---- Blocks ---------------------------------------------------------------------------

  const headingIds = new Map<string, string>()
  const headingKey = (id: string): string => {
    const existing = headingIds.get(id)
    if (existing !== undefined) return existing
    const key = `h${headingIds.size + 1}`
    headingIds.set(id, key)
    return key
  }

  const HEADING_SIZES = [18, 14.5, 12.5, 11.5]
  const headingSize = (level: number): number =>
    HEADING_SIZES[Math.min(Math.max(level, 1), HEADING_SIZES.length) - 1] ??
    11.5

  const paragraphNode = (runs: ReadonlyArray<Run>): PdfNode | undefined => {
    if (runs.every(run => run.text === '')) return undefined
    return { text: runInlines(runs, body), margin: [0, 0, 0, 6] }
  }

  const imageNode = (
    imageId: string,
    fit: [number, number],
  ): PdfNode | undefined => {
    const data = images.get(imageId)
    return data === undefined
      ? undefined
      : { image: data, fit, alignment: 'center' }
  }

  const tableNode = (
    rows: ReadonlyArray<ReadonlyArray<TableCell>>,
    width: number,
  ): PdfNode | undefined => {
    if (rows.length === 0) return undefined
    const occupied = new Set<string>()
    type Placed = Readonly<{ row: number; column: number; cell: TableCell }>
    const placed: Array<Placed> = []
    let columns = 0
    rows.forEach((cells, row) => {
      let column = 0
      cells.forEach(cell => {
        while (occupied.has(`${row},${column}`)) column += 1
        const colspan = Math.max(1, cell.colspan)
        const rowspan = Math.min(Math.max(1, cell.rowspan), rows.length - row)
        for (let r = row; r < row + rowspan; r += 1) {
          for (let c = column; c < column + colspan; c += 1) {
            occupied.add(`${r},${c}`)
          }
        }
        placed.push({ row, column, cell })
        column += colspan
        columns = Math.max(columns, column)
      })
    })
    if (columns === 0) return undefined
    const pixels: Array<number | undefined> = Array.from(
      { length: columns },
      () => undefined,
    )
    placed.forEach(({ column, cell }) => {
      cell.colwidth?.forEach((pixel, offset) => {
        if (pixels[column + offset] === undefined && pixel > 0) {
          pixels[column + offset] = pixel
        }
      })
    })
    const known = pixels.filter(pixel => pixel !== undefined)
    const widths: Array<number | string> =
      known.length === 0
        ? pixels.map(() => '*')
        : known.length === columns
          ? pixels.map(pixel => {
              const total = known.reduce((sum, value) => sum + value, 0)
              return ((pixel ?? 0) / total) * (width - 1)
            })
          : (() => {
              const scale = Math.min(
                0.75,
                (width * 0.7) / (known.reduce((sum, v) => sum + v, 0) || 1),
              )
              return pixels.map(pixel =>
                pixel === undefined ? '*' : pixel * scale,
              )
            })()
    const inner = Math.max(40, width / columns - 2 * CELL_PADDING)
    const matrix: Array<Array<PdfNode>> = rows.map(() =>
      Array.from({ length: columns }, (): PdfNode => ({})),
    )
    placed.forEach(({ row, column, cell }) => {
      const colspan = Math.max(1, cell.colspan)
      const rowspan = Math.min(Math.max(1, cell.rowspan), rows.length - row)
      const stack = blocksNodes(cell.blocks, inner * colspan)
      const target: PdfNode = {
        stack: stack.length === 0 ? [{ text: '' }] : stack,
        ...(cell.header ? { fillColor: derived.tableHeaderFill } : {}),
        ...(colspan > 1 ? { colSpan: colspan } : {}),
        ...(rowspan > 1 ? { rowSpan: rowspan } : {}),
      }
      const line = matrix[row]
      if (line !== undefined) line[column] = target
    })
    const headerRows = rows.findIndex(
      cells => !cells.every(cell => cell.header),
    )
    const repeated = headerRows === -1 ? 0 : headerRows
    return {
      table: {
        headerRows: repeated,
        widths,
        body: matrix,
      },
      layout: {
        hLineWidth: () => 0.5,
        vLineWidth: () => 0.5,
        hLineColor: () => derived.rule,
        vLineColor: () => derived.rule,
        paddingLeft: () => CELL_PADDING,
        paddingRight: () => CELL_PADDING,
        paddingTop: () => 3,
        paddingBottom: () => 1,
      },
      margin: [0, 2, 0, 8],
    }
  }

  const KEEP_LIMIT = 700

  const blockText = (block: Block): number => {
    if (block.type === 'paragraph' || block.type === 'rich_heading') {
      return block.runs.reduce((sum, run) => sum + run.text.length, 0)
    }
    if (block.type === 'note') return block.text.length
    if (block.type === 'field') {
      return block.blocks.reduce((sum, inner) => sum + blockText(inner), 0)
    }
    return Number.POSITIVE_INFINITY
  }

  const blockNodes = (block: Block, width: number): ReadonlyArray<PdfNode> => {
    switch (block.type) {
      case 'logo': {
        const node = imageNode(block.imageId, [140, 70])
        return node === undefined
          ? []
          : [
              {
                ...node,
                alignment: 'left',
                margin: [0, 0, 0, 24],
              },
            ]
      }
      case 'cover_line': {
        const size =
          block.emphasis === 'title'
            ? 30
            : block.emphasis === 'subtitle'
              ? 15
              : 12
        const style: TextStyle =
          block.emphasis === 'normal'
            ? body
            : block.emphasis === 'title'
              ? { ...heading, color: look.primary }
              : { family: look.headingFont }
        return [
          {
            text: inlines(block.text, style),
            fontSize: size,
            margin: [0, block.emphasis === 'title' ? 90 : 4, 0, 6],
          },
        ]
      }
      case 'stamp':
        return [
          {
            table: {
              widths: ['auto'],
              body: [
                [
                  {
                    text: inlines(block.text, {
                      ...heading,
                      color: look.accent,
                    }),
                    fontSize: 13,
                    margin: [10, 4, 10, 4],
                  },
                ],
              ],
            },
            layout: {
              hLineWidth: () => 1.5,
              vLineWidth: () => 1.5,
              hLineColor: () => look.accent,
              vLineColor: () => look.accent,
            },
            margin: [0, 24, 0, 0],
          },
        ]
      case 'contents':
        return [
          {
            text: inlines(block.title, { ...heading, color: look.primary }),
            fontSize: headingSize(1),
            margin: [0, 0, 0, 10],
          },
          ...block.entries.map(entry => contentsRow(entry)),
        ]
      case 'heading':
        return [
          {
            text: inlines(block.text, { ...heading, color: look.primary }),
            fontSize: headingSize(block.level),
            id: headingKey(block.id),
            headlineLevel: block.level,
            margin: [0, block.level === 1 ? 16 : 10, 0, 6],
          },
        ]
      case 'rich_heading':
        return [
          {
            text: runInlines(block.runs, {
              ...heading,
              bold: true,
            }),
            fontSize: headingSize(block.level + 1),
            margin: [0, 8, 0, 4],
          },
        ]
      case 'paragraph': {
        const node = paragraphNode(block.runs)
        return node === undefined ? [] : [node]
      }
      case 'list': {
        const items = block.items.map((item): PdfNode => {
          const nodes = blocksNodes(item, width - LIST_INDENT)
          return nodes.length === 1 && nodes[0] !== undefined
            ? { ...nodes[0], margin: [0, 0, 0, 2] }
            : { stack: nodes.length === 0 ? [{ text: '' }] : nodes }
        })
        if (items.length === 0) return []
        return block.ordered
          ? [{ ol: items, start: block.start, margin: [0, 0, 0, 6] }]
          : [{ ul: items, margin: [0, 0, 0, 6] }]
      }
      case 'table': {
        const node = tableNode(block.rows, width)
        return node === undefined ? [] : [node]
      }
      case 'figure': {
        const node = imageNode(block.imageId, [width, 300])
        const caption = block.caption.some(run => run.text !== '')
          ? [
              {
                text: runInlines(block.caption, { ...body, italics: true }),
                alignment: 'center',
                fontSize: 9,
                margin: [0, 2, 0, 8],
              },
            ]
          : []
        return node === undefined
          ? [
              {
                text: inlines('[Image not available]', {
                  ...body,
                  italics: true,
                }),
                margin: [0, 0, 0, 6],
              },
              ...caption,
            ]
          : [
              { ...node, margin: [0, 4, 0, caption.length === 0 ? 8 : 0] },
              ...caption,
            ]
      }
      case 'field': {
        const inner = blocksNodes(block.blocks, width)
        if (inner.length === 0) return []
        return [
          {
            text: inlines(block.label, {
              ...heading,
              color: look.primary,
            }),
            fontSize: 9.5,
            margin: [0, 6, 0, 2],
          },
          ...inner,
        ]
      }
      case 'group':
        return [
          {
            text: inlines(block.label, { ...heading, color: look.accent }),
            fontSize: 11.5,
            margin: [0, 10, 0, 4],
          },
          {
            stack: blocksNodes(block.blocks, width - GROUP_INDENT),
            margin: [GROUP_INDENT, 0, 0, 4],
          },
        ]
      case 'signature':
        return [
          {
            stack: [
              {
                text: inlines(block.label, { ...heading, color: look.primary }),
                fontSize: 9.5,
                margin: [0, 6, 0, 22],
              },
              {
                canvas: [
                  {
                    type: 'line',
                    x1: 0,
                    y1: 0,
                    x2: Math.min(220, width),
                    y2: 0,
                    lineWidth: 0.7,
                    lineColor: look.text,
                  },
                ],
              },
              {
                text: inlines(
                  block.date === undefined
                    ? block.name
                    : `${block.name === '' ? '' : `${block.name}, `}${block.date}`,
                  body,
                ),
                fontSize: 9.5,
                margin: [0, 3, 0, 10],
              },
            ],
            unbreakable: true,
          },
        ]
      case 'note':
        return [
          {
            text: inlines(block.text, { ...body, italics: true }),
            margin: [0, 0, 0, 6],
          },
        ]
    }
  }

  // NOTE: A heading is kept with the first short block after it, so a heading
  // never stands alone at the foot of a page.
  const blocksNodes = (
    blocks: ReadonlyArray<Block>,
    width: number,
  ): ReadonlyArray<PdfNode> => {
    const out: Array<PdfNode> = []
    let index = 0
    while (index < blocks.length) {
      const block = blocks[index]
      const next = blocks[index + 1]
      if (
        block !== undefined &&
        (block.type === 'heading' || block.type === 'rich_heading') &&
        next !== undefined &&
        blockText(next) <= KEEP_LIMIT &&
        next.type !== 'heading'
      ) {
        out.push({
          stack: [...blockNodes(block, width), ...blockNodes(next, width)],
          unbreakable: true,
        })
        index += 2
      } else if (block !== undefined) {
        out.push(...blockNodes(block, width))
        index += 1
      } else {
        index += 1
      }
    }
    return out
  }

  // ---- The contents ---------------------------------------------------------------------

  const hasContents = parts.some(part =>
    part.blocks.some(block => block.type === 'contents'),
  )

  const labelOfHeading = (id: string): string => {
    if (measured === undefined) return '00'
    const page = measured.headingPages.get(headingKey(id))
    if (page === undefined) return ''
    const known = geometryOf(parts, measured.partOfPage)
    return known.labels[page - 1] ?? ''
  }

  const contentsRow = (entry: ContentsEntry): PdfNode => {
    const text =
      entry.number === undefined
        ? entry.title
        : `${entry.number} ${entry.title}`
    return {
      columns: [
        {
          text: inlines(text, body),
          width: '*',
          linkToDestination: headingKey(entry.headingId),
        },
        {
          text: inlines(labelOfHeading(entry.headingId), body),
          width: LABEL_COLUMN,
          alignment: 'right',
        },
      ],
      columnGap: 8,
      margin: [Math.max(0, entry.level - 1) * 14, 0, 0, 3],
    }
  }

  // ---- Header and footer ---------------------------------------------------------------

  const furnitureOf = (index: number): HeaderFooter | undefined => {
    const { furniture } = description
    return parts[index]?.kind === 'cover'
      ? (furniture.cover ?? furniture.normal)
      : furniture.normal
  }

  const segmentNodes = (
    segments: ReadonlyArray<Segment>,
    page: string,
    pages: string,
  ): ReadonlyArray<PdfNode> =>
    segments.flatMap(segment =>
      inlines(
        segment.kind === 'text'
          ? segment.text
          : segment.kind === 'page'
            ? page
            : pages,
        body,
      ),
    )

  const redactionLabel = description.redactionLabel
  const furnitureColor = derived.furniture

  const header = (currentPage: number): PdfNode | null => {
    const now = geometryNow()
    const index = now.partOfPage[currentPage - 1] ?? 0
    const isCover = parts[index]?.kind === 'cover'
    const segments = furnitureOf(index)?.header
    const label = isCover ? undefined : redactionLabel
    if (segments === undefined && label === undefined) return null
    const page = now.labels[currentPage - 1] ?? String(currentPage)
    const pages = now.totals[currentPage - 1] ?? String(now.pageCount)
    return {
      columns: [
        { text: '', width: 90 },
        {
          text:
            segments === undefined ? '' : segmentNodes(segments, page, pages),
          alignment: 'center',
          width: '*',
        },
        {
          text:
            label === undefined
              ? ''
              : inlines(label, { ...heading, color: look.accent }),
          alignment: 'right',
          width: 90,
        },
      ],
      fontSize: 8.5,
      color: furnitureColor,
      margin: [MARGIN_X, 28, MARGIN_X, 0],
    }
  }

  const footer = (currentPage: number): PdfNode | null => {
    const now = geometryNow()
    const index = now.partOfPage[currentPage - 1] ?? 0
    const segments = furnitureOf(index)?.footer
    if (segments === undefined) return null
    const page = now.labels[currentPage - 1] ?? String(currentPage)
    const pages = now.totals[currentPage - 1] ?? String(now.pageCount)
    return {
      text: segmentNodes(segments, page, pages),
      alignment: 'center',
      fontSize: 8.5,
      color: furnitureColor,
      margin: [MARGIN_X, 24, MARGIN_X, 0],
    }
  }

  // ---- Sections ---------------------------------------------------------------------------

  const paintsBackground = look.background.toLowerCase() !== '#ffffff'
  const sections = parts.map((part, index): PdfNode => ({
    section: blocksNodes(part.blocks, CONTENT_WIDTH),
    background: (currentPage: number): PdfNode | null => {
      if (currentPage === 1) {
        partOfPage = []
        geometry = undefined
      }
      partOfPage[currentPage - 1] = index
      return paintsBackground
        ? {
            canvas: [
              {
                type: 'rect',
                x: 0,
                y: 0,
                w: PAGE_WIDTH,
                h: PAGE_HEIGHT,
                color: look.background,
              },
            ],
          }
        : null
    },
  }))

  // NOTE: Header and footer are built when pdfmake runs them, after the fonts
  // were loaded, so the fonts their text needs are registered now.
  parts.forEach((_, index) => {
    const furniture = furnitureOf(index)
    ;[furniture?.header, furniture?.footer].forEach(segments => {
      if (segments !== undefined) segmentNodes(segments, '1', '1')
    })
  })
  if (redactionLabel !== undefined) inlines(redactionLabel, heading)

  const created = new Date(`${description.version.date}T00:00:00Z`)
  const date = Number.isNaN(created.getTime()) ? new Date(0) : created

  const definition: PdfNode = {
    pageSize: 'A4',
    pageMargins: [MARGIN_X, 72, MARGIN_X, 64],
    info: {
      title: description.info.title,
      subject: description.info.subject,
      author: description.info.author,
      creator: 'Quoroom',
      producer: 'Quoroom',
      creationDate: date,
      modDate: date,
    },
    defaultStyle: {
      font: fontName(look.bodyFont, 'latin'),
      fontSize: 10.5,
      lineHeight: 1.3,
      color: look.text,
    },
    content: sections,
    header,
    footer,
    pageBreakBefore: (current: {
      id?: string
      startPosition?: { pageNumber: number }
    }): boolean => {
      if (current.id !== undefined && current.startPosition !== undefined) {
        headingPages.set(current.id, current.startPosition.pageNumber)
      }
      return false
    },
  }

  return {
    definition,
    get fonts() {
      return Object.fromEntries(used)
    },
    get fontFiles() {
      return [...new Set([...used.values()].flatMap(def => Object.values(def)))]
    },
    hasContents,
    measured: () => ({
      partOfPage: [...partOfPage],
      headingPages: new Map(headingPages),
    }),
  }
}

// ---- Rendering in two passes --------------------------------------------------------------

export type Render = (build: PdfBuild) => Promise<Uint8Array>

// NOTE: The shared driver: both adapters give it their own `render` (which
// loads the fonts the build names and calls pdfmake). A document with a
// contents is rendered once to learn where each heading falls and again with
// the page numbers filled in; the first result is dropped.
export const renderPdf = async (
  description: DocumentDescription,
  images: PdfImages,
  render: Render,
): Promise<Uint8Array> => {
  const first = buildPdf(description, images)
  if (!first.hasContents) return render(first)
  await render(first)
  return render(buildPdf(description, images, first.measured()))
}
