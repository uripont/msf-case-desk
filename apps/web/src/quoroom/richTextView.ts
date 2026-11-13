import { clsx } from 'clsx'
import { Array, Option } from 'effect'
import { Attribute, Html, HtmlBuilder } from 'foldkit/html'

import {
  type BlockNode,
  type InlineNode,
  type ListBlock,
  type ListItemNode,
  type Mark,
  type RichTextDoc,
  type TableCellNode,
  type TableHeaderNode,
  type TableRowNode,
  isRichTextEmpty,
} from '@case-desk/domain'

import './images/figureImage'
import { imageElement } from './images/spec'
import { markedChildren } from './marked'

// NOTE: Rich text shown without the editor, for drafts that are shared,
// revisions, and any report an author may only read. It is a plain Foldkit
// view of the domain document and never loads Tiptap. Headings 1 to 4 of the
// text are shown as the fourth to the seventh level of the page, below the
// section title. A table sits in a box that scrolls sideways, so a wide table
// never widens the page. An image is fetched and shown by the image element
// (stage 4d), with its caption and whether it is marked safe to share.

// NOTE: Every text block (paragraph, heading, figure caption) carries this
// data attribute, in document order. The selection reader (`selection.ts`)
// finds anchors through it, in the text-offset scheme of the domain
// (`richtext-offsets.ts`): the text of the blocks, a '\n' between them, a
// hard break as '\n', so nothing the view adds (labels, bullets, the "Marked
// safe to share" line, the image) is counted.
export const RICH_TEXT_BLOCK = 'rt-block'

const HEADING_CLASS = 'mt-2 font-bold text-msf-black'

const withMark =
  <M>(h: HtmlBuilder<M>, mark: Mark) =>
  (child: Html): Html =>
    mark.type === 'bold'
      ? h.strong([], [child])
      : mark.type === 'italic'
        ? h.em([], [child])
        : mark.type === 'underline'
          ? h.span([h.Class('underline')], [child])
          : h.a(
              [
                h.Href(mark.attrs.href),
                h.Rel('noopener noreferrer nofollow'),
                h.Target('_blank'),
                h.Class('text-msf-red underline'),
              ],
              [child],
            )

// NOTE: `marks` are the strings a redacted preview highlights (the labels that
// took the place of names, and the placeholder of a withheld image); empty
// everywhere else.
type Marks = ReadonlyArray<string>

const inlineView = <M>(
  h: HtmlBuilder<M>,
  node: InlineNode,
  marks: Marks,
): Html =>
  node.type === 'hardBreak'
    ? h.br([])
    : Array.reduce(
        node.marks ?? [],
        h.span([], markedChildren(h, node.text, marks)),
        (inner, mark) => withMark(h, mark)(inner),
      )

const inlines = <M>(
  h: HtmlBuilder<M>,
  nodes: ReadonlyArray<InlineNode> | undefined,
  marks: Marks,
): ReadonlyArray<Html> =>
  Array.map(nodes ?? [], node => inlineView(h, node, marks))

const HEADING_TAGS = ['h4', 'h5', 'h6', 'h6'] as const

const headingView = <M>(
  h: HtmlBuilder<M>,
  level: number,
  children: ReadonlyArray<Html>,
): Html => {
  const block = h.DataAttribute(RICH_TEXT_BLOCK, '')
  const className = clsx(
    HEADING_CLASS,
    level === 1 && 'text-2xl',
    level === 2 && 'text-xl',
    level >= 3 && 'text-lg',
  )
  const tag = HEADING_TAGS[level - 1] ?? 'h6'
  return tag === 'h4'
    ? h.h4([h.Class(className), block], children)
    : tag === 'h5'
      ? h.h5([h.Class(className), block], children)
      : h.h6([h.Class(className), block], children)
}

const listItemView = <M>(
  h: HtmlBuilder<M>,
  item: ListItemNode,
  marks: Marks,
): Html =>
  h.li(
    [],
    Array.map(item.content, block => listBlockView(h, block, marks)),
  )

const listBlockView = <M>(
  h: HtmlBuilder<M>,
  block: ListBlock,
  marks: Marks,
): Html => {
  if (block.type === 'paragraph') {
    return h.p(
      [h.Class('text-pretty'), h.DataAttribute(RICH_TEXT_BLOCK, '')],
      inlines(h, block.content, marks),
    )
  }
  if (block.type === 'heading') {
    return headingView(h, block.attrs.level, inlines(h, block.content, marks))
  }
  if (block.type === 'bulletList') {
    return h.ul(
      [h.Class('list-disc pl-6')],
      Array.map(block.content, item => listItemView(h, item, marks)),
    )
  }
  return h.ol(
    [h.Class('list-decimal pl-6'), h.Start(block.attrs?.start ?? 1)],
    Array.map(block.content, item => listItemView(h, item, marks)),
  )
}

const cellView = <M>(
  h: HtmlBuilder<M>,
  cell: TableCellNode | TableHeaderNode,
  marks: Marks,
): Html => {
  const attributes = [
    h.Class('border border-msf-line px-2 py-1 text-left align-top'),
    ...Option.match(Option.fromNullishOr(cell.attrs?.colspan), {
      onNone: () => [],
      onSome: span => [h.Colspan(span)],
    }),
    ...Option.match(Option.fromNullishOr(cell.attrs?.rowspan), {
      onNone: () => [],
      onSome: span => [h.Rowspan(span)],
    }),
  ]
  const children = Array.map(cell.content, block =>
    listBlockView(h, block, marks),
  )
  return cell.type === 'tableHeader'
    ? h.th([...attributes, h.Class('bg-msf-mist font-medium')], children)
    : h.td(attributes, children)
}

const rowView = <M>(h: HtmlBuilder<M>, row: TableRowNode, marks: Marks): Html =>
  h.tr(
    [],
    Array.map(row.content, cell => cellView(h, cell, marks)),
  )

const blockView = <M>(
  h: HtmlBuilder<M>,
  block: BlockNode,
  reportId: string,
  imageContext: string,
  marks: Marks,
): Html => {
  if (block.type === 'table') {
    return h.div(
      [
        h.Class('max-w-full overflow-x-auto'),
        h.DataAttribute('rich-text', 'table'),
        h.Tabindex(0),
        h.Role('region'),
        h.AriaLabel('Table'),
      ],
      [
        h.table(
          [h.Class('border-collapse text-base')],
          [
            h.tbody(
              [],
              Array.map(block.content, row => rowView(h, row, marks)),
            ),
          ],
        ),
      ],
    )
  }
  if (block.type === 'figure') {
    const picture = imageElement.withMessage(h)
    return h.figure(
      [
        h.Class('flex flex-col gap-1'),
        h.DataAttribute('image-id', block.attrs.imageId),
        h.DataAttribute('safe', block.attrs.safeToShare ? 'true' : 'false'),
      ],
      [
        reportId === ''
          ? h.div(
              [
                h.Class(
                  'border border-msf-line bg-msf-mist px-3 py-6 text-center text-base text-msf-grey',
                ),
              ],
              [block.attrs.alt === '' ? 'Image' : `Image: ${block.attrs.alt}`],
            )
          : picture([
              picture.ImageId(block.attrs.imageId),
              picture.Report(reportId),
              picture.Context(imageContext),
              picture.Alt(block.attrs.alt),
              h.Class('block max-w-full border border-msf-line bg-msf-mist'),
            ]),
        h.p(
          [
            h.Class(
              clsx(
                'text-sm font-medium',
                block.attrs.safeToShare ? 'text-msf-ink' : 'text-msf-grey',
              ),
            ),
          ],
          [
            block.attrs.safeToShare
              ? 'Marked safe to share.'
              : 'Not marked safe to share. Withheld from redacted views.',
          ],
        ),
        h.figcaption(
          [
            h.Class('text-sm text-msf-grey'),
            h.DataAttribute(RICH_TEXT_BLOCK, ''),
          ],
          inlines(h, block.content, marks),
        ),
      ],
    )
  }
  return listBlockView(h, block, marks)
}

export const richTextView = <M>(
  h: HtmlBuilder<M>,
  doc: RichTextDoc,
  attributes: ReadonlyArray<Attribute<M>> = [],
  // NOTE: The report whose images are shown. Empty: no images are fetched and a
  // figure is a labelled box.
  reportId = '',
  // NOTE: The version the images are read through (`imageContextToken`); empty
  // is the author's working copy.
  imageContext = '',
  // NOTE: Strings to highlight (the redacted preview).
  marks: Marks = [],
): Html =>
  isRichTextEmpty(doc)
    ? h.p(
        [h.Class('text-base text-msf-grey'), ...attributes],
        ['Nothing written.'],
      )
    : h.div(
        [
          h.Class('flex min-w-0 flex-col gap-3 text-lg text-msf-ink'),
          ...attributes,
        ],
        Array.map(doc.content, block =>
          blockView(h, block, reportId, imageContext, marks),
        ),
      )
