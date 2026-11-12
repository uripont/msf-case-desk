import { Result, Schema, SchemaIssue } from 'effect'

// NOTE: The rich text of a report (D3) is our own strict subset of the Tiptap
// JSON document. This file does not import Tiptap. Anything outside the subset,
// an unknown node, an unknown mark or an unknown attribute, is refused by
// `decodeRichText`. The editor wrapper (stage 4) must configure Tiptap to
// produce exactly these nodes.
//
// Conventions:
// - Images are `figure` nodes: a block with an image reference, an `alt` text,
//   a `safeToShare` flag (D14) and the caption as inline content.
// - The schema tolerates what Tiptap emits by default (empty text nodes,
//   `null` and default attributes, `target` and `rel` on links) so that stored
//   documents decode. `canonicalRichText` removes those variations.

export const MAX_HEADING_LEVEL = 4
export const MAX_COLSPAN = 50
export const MAX_COLWIDTH = 2000
export const LINK_PROTOCOLS = ['http:', 'https:', 'mailto:', 'tel:'] as const

const Attribute = Schema.NullOr(Schema.String.check(Schema.isMaxLength(500)))

// ---- Marks ------------------------------------------------------------------

export const BoldMark = Schema.Struct({ type: Schema.Literal('bold') })
export const ItalicMark = Schema.Struct({ type: Schema.Literal('italic') })
export const UnderlineMark = Schema.Struct({
  type: Schema.Literal('underline'),
})
export const LinkMark = Schema.Struct({
  type: Schema.Literal('link'),
  attrs: Schema.Struct({
    href: Schema.String.check(
      Schema.isMaxLength(2000),
      Schema.isPattern(/^(https?:\/\/|mailto:|tel:)\S+$/i),
    ),
    title: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(300))),
    target: Schema.optionalKey(Attribute),
    rel: Schema.optionalKey(Attribute),
    class: Schema.optionalKey(Attribute),
  }),
})
export const Mark = Schema.Union([
  BoldMark,
  ItalicMark,
  UnderlineMark,
  LinkMark,
])
export type Mark = typeof Mark.Type
export type MarkType = Mark['type']

// ---- Inline nodes -----------------------------------------------------------

export const TextNode = Schema.Struct({
  type: Schema.Literal('text'),
  text: Schema.String.check(Schema.isMaxLength(100_000)),
  marks: Schema.optionalKey(Schema.Array(Mark)),
})
export type TextNode = typeof TextNode.Type

export const HardBreakNode = Schema.Struct({
  type: Schema.Literal('hardBreak'),
})
export type HardBreakNode = typeof HardBreakNode.Type

export const InlineNode = Schema.Union([TextNode, HardBreakNode])
export type InlineNode = typeof InlineNode.Type

// ---- Blocks -----------------------------------------------------------------

export const ParagraphNode = Schema.Struct({
  type: Schema.Literal('paragraph'),
  content: Schema.optionalKey(Schema.Array(InlineNode)),
})
export type ParagraphNode = typeof ParagraphNode.Type

export const HeadingNode = Schema.Struct({
  type: Schema.Literal('heading'),
  attrs: Schema.Struct({
    level: Schema.Int.check(
      Schema.isBetween({ minimum: 1, maximum: MAX_HEADING_LEVEL }),
    ),
  }),
  content: Schema.optionalKey(Schema.Array(InlineNode)),
})
export type HeadingNode = typeof HeadingNode.Type

// NOTE: An image with its caption. The caption is inline content so it is
// redacted and compared like any other text.
export const FigureNode = Schema.Struct({
  type: Schema.Literal('figure'),
  attrs: Schema.Struct({
    imageId: Schema.String.check(
      Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/),
    ),
    alt: Schema.String.check(Schema.isMaxLength(500)),
    safeToShare: Schema.Boolean,
  }),
  content: Schema.optionalKey(Schema.Array(InlineNode)),
})
export type FigureNode = typeof FigureNode.Type

export type ListItemNode = {
  readonly type: 'listItem'
  readonly content: ReadonlyArray<ListBlock>
}
export type BulletListNode = {
  readonly type: 'bulletList'
  readonly content: ReadonlyArray<ListItemNode>
}
export type OrderedListNode = {
  readonly type: 'orderedList'
  readonly attrs?: { readonly start?: number; readonly type?: null }
  readonly content: ReadonlyArray<ListItemNode>
}
// NOTE: What may sit inside a list item or a table cell: no tables, no images.
export type ListBlock =
  | ParagraphNode
  | HeadingNode
  | BulletListNode
  | OrderedListNode

export const ListItemNode: Schema.Codec<ListItemNode> = Schema.Struct({
  type: Schema.Literal('listItem'),
  content: Schema.Array(
    Schema.suspend((): Schema.Codec<ListBlock> => ListBlock),
  ).check(Schema.isNonEmpty()),
})

export const BulletListNode: Schema.Codec<BulletListNode> = Schema.Struct({
  type: Schema.Literal('bulletList'),
  content: Schema.Array(ListItemNode).check(Schema.isNonEmpty()),
})

export const OrderedListNode: Schema.Codec<OrderedListNode> = Schema.Struct({
  type: Schema.Literal('orderedList'),
  attrs: Schema.optionalKey(
    Schema.Struct({
      start: Schema.optionalKey(
        Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100_000 })),
      ),
      type: Schema.optionalKey(Schema.Null),
    }),
  ),
  content: Schema.Array(ListItemNode).check(Schema.isNonEmpty()),
})

export const ListBlock: Schema.Codec<ListBlock> = Schema.Union([
  ParagraphNode,
  HeadingNode,
  BulletListNode,
  OrderedListNode,
])

const cellAttrs = Schema.optionalKey(
  Schema.Struct({
    colspan: Schema.optionalKey(
      Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: MAX_COLSPAN })),
    ),
    rowspan: Schema.optionalKey(
      Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: MAX_COLSPAN })),
    ),
    colwidth: Schema.optionalKey(
      Schema.NullOr(
        Schema.Array(
          Schema.Int.check(
            Schema.isBetween({ minimum: 1, maximum: MAX_COLWIDTH }),
          ),
        ),
      ),
    ),
  }),
)

export const TableCellNode = Schema.Struct({
  type: Schema.Literal('tableCell'),
  attrs: cellAttrs,
  content: Schema.Array(ListBlock).check(Schema.isNonEmpty()),
})
export type TableCellNode = typeof TableCellNode.Type

export const TableHeaderNode = Schema.Struct({
  type: Schema.Literal('tableHeader'),
  attrs: cellAttrs,
  content: Schema.Array(ListBlock).check(Schema.isNonEmpty()),
})
export type TableHeaderNode = typeof TableHeaderNode.Type

export const TableRowNode = Schema.Struct({
  type: Schema.Literal('tableRow'),
  content: Schema.Array(Schema.Union([TableHeaderNode, TableCellNode])).check(
    Schema.isNonEmpty(),
  ),
})
export type TableRowNode = typeof TableRowNode.Type

export const TableNode = Schema.Struct({
  type: Schema.Literal('table'),
  content: Schema.Array(TableRowNode).check(Schema.isNonEmpty()),
})
export type TableNode = typeof TableNode.Type

export const BlockNode = Schema.Union([
  ParagraphNode,
  HeadingNode,
  BulletListNode,
  OrderedListNode,
  TableNode,
  FigureNode,
])
export type BlockNode = typeof BlockNode.Type

export const RichTextDoc = Schema.Struct({
  type: Schema.Literal('doc'),
  content: Schema.Array(BlockNode).check(Schema.isNonEmpty()),
})
export type RichTextDoc = typeof RichTextDoc.Type

export const EMPTY_RICH_TEXT: RichTextDoc = {
  type: 'doc',
  content: [{ type: 'paragraph' }],
}

// ---- Strict decoding ----------------------------------------------------------

export type RichTextProblem = Readonly<{
  path: ReadonlyArray<string | number>
  message: string
}>

const formatIssues = SchemaIssue.makeFormatterStandardSchemaV1()

export const issuesToProblems = (
  issue: SchemaIssue.Issue,
): ReadonlyArray<RichTextProblem> => {
  const result = formatIssues(issue)
  return ('issues' in result ? result.issues : []).map(entry => ({
    path: (entry.path ?? []).map(key =>
      typeof key === 'object'
        ? (key.key as string | number)
        : (key as string | number),
    ),
    message: entry.message,
  }))
}

const decodeShape = Schema.decodeUnknownResult(RichTextDoc)
const encodeShape = Schema.encodeUnknownResult(RichTextDoc)

// NOTE: Unknown nodes, marks and attributes are refused, not dropped.
export const decodeRichText = (
  input: unknown,
): Result.Result<RichTextDoc, ReadonlyArray<RichTextProblem>> => {
  const decoded = decodeShape(input, {
    errors: 'all',
    onExcessProperty: 'error',
  })
  return Result.isFailure(decoded)
    ? Result.fail(issuesToProblems(decoded.failure.issue))
    : Result.succeed(decoded.success)
}

export const encodeRichText = (
  doc: RichTextDoc,
): Result.Result<unknown, ReadonlyArray<RichTextProblem>> => {
  const encoded = encodeShape(doc, { errors: 'all' })
  return Result.isFailure(encoded)
    ? Result.fail(issuesToProblems(encoded.failure.issue))
    : Result.succeed(encoded.success)
}

// ---- Canonical form -----------------------------------------------------------

// NOTE: The canonical form is what comparison (1d) and redaction (1e) work on.
// It removes what the editor may vary without the author changing anything:
//
// - text nodes with no text are dropped;
// - adjacent text nodes with the same marks are merged;
// - marks are deduplicated by type (of two links, the one with the smaller
//   JSON wins, so the order never matters) and sorted: link, bold,
//   italic, underline; an empty marks list is removed;
// - link attributes other than `href` and `title` are dropped;
// - attributes with their default value are removed (`start` 1, `colspan` 1,
//   `rowspan` 1, a null or empty `colwidth`, a null list `type`), and an
//   `attrs` object left empty is removed;
// - an empty `content` list of a paragraph, heading or figure is removed.
//
// `canonicalRichText` is idempotent. Everything else (the order of blocks, the
// text, the attributes that matter, `safeToShare`) is kept exactly.

const MARK_ORDER: Readonly<Record<MarkType, number>> = {
  link: 0,
  bold: 1,
  italic: 2,
  underline: 3,
}

const canonicalMark = (mark: Mark): Mark => {
  if (mark.type !== 'link') {
    return { type: mark.type }
  }
  return {
    type: 'link',
    attrs: {
      href: mark.attrs.href,
      ...(mark.attrs.title === undefined || mark.attrs.title === ''
        ? {}
        : { title: mark.attrs.title }),
    },
  }
}

const canonicalMarks = (marks: ReadonlyArray<Mark>): ReadonlyArray<Mark> => {
  const byType = new Map<MarkType, Mark>()
  for (const mark of marks.map(canonicalMark)) {
    const kept = byType.get(mark.type)
    if (kept === undefined || JSON.stringify(mark) < JSON.stringify(kept)) {
      byType.set(mark.type, mark)
    }
  }
  return [...byType.values()].sort(
    (a, b) => MARK_ORDER[a.type] - MARK_ORDER[b.type],
  )
}

const marksKey = (marks: ReadonlyArray<Mark> | undefined): string =>
  JSON.stringify(marks ?? [])

const canonicalInline = (
  nodes: ReadonlyArray<InlineNode> | undefined,
): ReadonlyArray<InlineNode> | undefined => {
  if (nodes === undefined) {
    return undefined
  }
  const out: Array<InlineNode> = []
  for (const node of nodes) {
    if (node.type === 'hardBreak') {
      out.push({ type: 'hardBreak' })
      continue
    }
    if (node.text === '') {
      continue
    }
    const marks = canonicalMarks(node.marks ?? [])
    const last = out[out.length - 1]
    if (
      last !== undefined &&
      last.type === 'text' &&
      marksKey(last.marks) === marksKey(marks)
    ) {
      out[out.length - 1] = { ...last, text: last.text + node.text }
    } else {
      out.push({
        type: 'text',
        text: node.text,
        ...(marks.length === 0 ? {} : { marks }),
      })
    }
  }
  return out.length === 0 ? undefined : out
}

const withContent = <A extends { readonly type: string }>(
  node: A,
  content: ReadonlyArray<InlineNode> | undefined,
): A & { readonly content?: ReadonlyArray<InlineNode> } =>
  content === undefined ? node : { ...node, content }

const canonicalListBlock = (block: ListBlock): ListBlock => {
  switch (block.type) {
    case 'paragraph':
      return withContent(
        { type: 'paragraph' as const },
        canonicalInline(block.content),
      )
    case 'heading':
      return withContent(
        { type: 'heading' as const, attrs: { level: block.attrs.level } },
        canonicalInline(block.content),
      )
    case 'bulletList':
      return {
        type: 'bulletList',
        content: block.content.map(canonicalListItem),
      }
    case 'orderedList': {
      const start = block.attrs?.start
      return {
        type: 'orderedList',
        ...(start === undefined || start === 1 ? {} : { attrs: { start } }),
        content: block.content.map(canonicalListItem),
      }
    }
  }
}

const canonicalListItem = (item: ListItemNode): ListItemNode => ({
  type: 'listItem',
  content: item.content.map(canonicalListBlock),
})

const canonicalCellAttrs = (
  attrs: TableCellNode['attrs'],
): { attrs?: NonNullable<TableCellNode['attrs']> } => {
  const colspan = attrs?.colspan ?? 1
  const rowspan = attrs?.rowspan ?? 1
  const colwidth = attrs?.colwidth ?? null
  const out = {
    ...(colspan === 1 ? {} : { colspan }),
    ...(rowspan === 1 ? {} : { rowspan }),
    ...(colwidth === null || colwidth.length === 0 ? {} : { colwidth }),
  }
  return Object.keys(out).length === 0 ? {} : { attrs: out }
}

const canonicalCell = (
  cell: TableCellNode | TableHeaderNode,
): TableCellNode | TableHeaderNode => ({
  type: cell.type,
  ...canonicalCellAttrs(cell.attrs),
  content: cell.content.map(canonicalListBlock),
})

const canonicalBlock = (block: BlockNode): BlockNode => {
  switch (block.type) {
    case 'table':
      return {
        type: 'table',
        content: block.content.map(row => ({
          type: 'tableRow' as const,
          content: row.content.map(canonicalCell),
        })),
      }
    case 'figure':
      return withContent(
        {
          type: 'figure' as const,
          attrs: {
            imageId: block.attrs.imageId,
            alt: block.attrs.alt,
            safeToShare: block.attrs.safeToShare,
          },
        },
        canonicalInline(block.content),
      )
    default:
      return canonicalListBlock(block)
  }
}

export const canonicalRichText = (doc: RichTextDoc): RichTextDoc => ({
  type: 'doc',
  content: doc.content.map(canonicalBlock),
})

// ---- Reading helpers ------------------------------------------------------------

const inlineText = (nodes: ReadonlyArray<InlineNode> | undefined): string =>
  (nodes ?? []).map(node => (node.type === 'text' ? node.text : '\n')).join('')

const blockTexts = (block: BlockNode | ListBlock): ReadonlyArray<string> => {
  switch (block.type) {
    case 'paragraph':
    case 'heading':
      return [inlineText(block.content)]
    case 'figure':
      return [inlineText(block.content)]
    case 'bulletList':
    case 'orderedList':
      return block.content.flatMap(item => item.content.flatMap(blockTexts))
    case 'table':
      return block.content.flatMap(row =>
        row.content.flatMap(cell => cell.content.flatMap(blockTexts)),
      )
  }
}

// NOTE: The plain text of a document, one entry per text block, in order.
export const richTextBlocks = (doc: RichTextDoc): ReadonlyArray<string> =>
  doc.content.flatMap(blockTexts)

const hasFigure = (block: BlockNode): boolean => block.type === 'figure'

// NOTE: A document is empty when it has no visible text and no image. This is
// what "filled" means for a rich text item.
export const isRichTextEmpty = (doc: RichTextDoc): boolean =>
  !doc.content.some(hasFigure) &&
  richTextBlocks(doc).every(text => text.trim() === '')

// NOTE: Every image the document references, in order, with its flag.
export const richTextFigures = (
  doc: RichTextDoc,
): ReadonlyArray<FigureNode['attrs']> =>
  doc.content.flatMap(block => (block.type === 'figure' ? [block.attrs] : []))
