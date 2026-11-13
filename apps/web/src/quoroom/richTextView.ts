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

// NOTE: Rich text shown without the editor, for drafts that are shared,
// revisions, and any report an author may only read. It is a plain Foldkit
// view of the domain document and never loads Tiptap. Headings 1 to 4 of the
// text are shown as the fourth to the seventh level of the page, below the
// section title. A table sits in a box that scrolls sideways, so a wide table
// never widens the page. An image is fetched and shown by the image element
// (stage 4d), with its caption and whether it is marked safe to share.

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

const inlineView = <M>(h: HtmlBuilder<M>, node: InlineNode): Html =>
  node.type === 'hardBreak'
    ? h.br([])
    : Array.reduce(node.marks ?? [], h.span([], [node.text]), (inner, mark) =>
        withMark(h, mark)(inner),
      )

const inlines = <M>(
  h: HtmlBuilder<M>,
  nodes: ReadonlyArray<InlineNode> | undefined,
): ReadonlyArray<Html> => Array.map(nodes ?? [], node => inlineView(h, node))

const HEADING_TAGS = ['h4', 'h5', 'h6', 'h6'] as const

const headingView = <M>(
  h: HtmlBuilder<M>,
  level: number,
  children: ReadonlyArray<Html>,
): Html => {
  const className = clsx(
    HEADING_CLASS,
    level === 1 && 'text-2xl',
    level === 2 && 'text-xl',
    level >= 3 && 'text-lg',
  )
  const tag = HEADING_TAGS[level - 1] ?? 'h6'
  return tag === 'h4'
    ? h.h4([h.Class(className)], children)
    : tag === 'h5'
      ? h.h5([h.Class(className)], children)
      : h.h6([h.Class(className)], children)
}

const listItemView = <M>(h: HtmlBuilder<M>, item: ListItemNode): Html =>
  h.li(
    [],
    Array.map(item.content, block => listBlockView(h, block)),
  )

const listBlockView = <M>(h: HtmlBuilder<M>, block: ListBlock): Html => {
  if (block.type === 'paragraph') {
    return h.p([h.Class('text-pretty')], inlines(h, block.content))
  }
  if (block.type === 'heading') {
    return headingView(h, block.attrs.level, inlines(h, block.content))
  }
  if (block.type === 'bulletList') {
    return h.ul(
      [h.Class('list-disc pl-6')],
      Array.map(block.content, item => listItemView(h, item)),
    )
  }
  return h.ol(
    [h.Class('list-decimal pl-6'), h.Start(block.attrs?.start ?? 1)],
    Array.map(block.content, item => listItemView(h, item)),
  )
}

const cellView = <M>(
  h: HtmlBuilder<M>,
  cell: TableCellNode | TableHeaderNode,
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
  const children = Array.map(cell.content, block => listBlockView(h, block))
  return cell.type === 'tableHeader'
    ? h.th([...attributes, h.Class('bg-msf-mist font-medium')], children)
    : h.td(attributes, children)
}

const rowView = <M>(h: HtmlBuilder<M>, row: TableRowNode): Html =>
  h.tr(
    [],
    Array.map(row.content, cell => cellView(h, cell)),
  )

const blockView = <M>(
  h: HtmlBuilder<M>,
  block: BlockNode,
  reportId: string,
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
              Array.map(block.content, row => rowView(h, row)),
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
          [h.Class('text-sm text-msf-grey')],
          inlines(h, block.content),
        ),
      ],
    )
  }
  return listBlockView(h, block)
}

export const richTextView = <M>(
  h: HtmlBuilder<M>,
  doc: RichTextDoc,
  attributes: ReadonlyArray<Attribute<M>> = [],
  // NOTE: The report whose images are shown. Empty: no images are fetched and a
  // figure is a labelled box.
  reportId = '',
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
        Array.map(doc.content, block => blockView(h, block, reportId)),
      )
