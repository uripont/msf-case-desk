import { Option, Schema } from 'effect'

import { COMMENT_ENTRIES, COMMENT_ITEM, COMMENT_SECTION } from './contentView'
import { RICH_TEXT_BLOCK } from './richTextView'

// NOTE: Reads the text the reader has selected in a read-only draft (stage
// 4g) as an anchor of the comment API: the top-level section, the entries
// passed through, the item, the character offsets in the item's text and the
// quoted text. The read-only view marks each text it shows with data
// attributes (`contentView.ts`); a selection that starts and ends in the same
// marked text is reported, anything else is ignored.
//
// NOTE: Anchors in rich text use the text-offset scheme of the domain
// (`richtext-offsets.ts`), the same the editor reports, so one comment anchor
// means the same words in both: the offsets count the text of the text blocks
// (marked `data-rt-block` by `richTextView.ts`: paragraphs, headings, figure
// captions) with one '\n' between blocks and a hard break as '\n'. Labels,
// the image and its "safe to share" line are not counted, and a selection may
// run across blocks. Texts without blocks (structured fields) are one string.

export const CommentSelection = Schema.Struct({
  sectionId: Schema.String,
  itemId: Schema.String,
  entryPath: Schema.Array(Schema.String),
  from: Schema.Int,
  to: Schema.Int,
  quoted: Schema.String,
})
export type CommentSelection = typeof CommentSelection.Type

const MAX_QUOTED = 2000

const containerOf = (node: Node | null): Element | null => {
  const element = node instanceof Element ? node : (node?.parentElement ?? null)
  return element === null ? null : element.closest(`[data-${COMMENT_ITEM}]`)
}

const BLOCK_SELECTOR = `[data-${RICH_TEXT_BLOCK}]`

// The anchor text of the blocks: their texts with a '\n' between.
const anchorTextOf = (blocks: ReadonlyArray<Element>): string =>
  blocks.map(textOf).join('\n')

const plainOffset = (container: Element, range: Range): number => {
  const before = document.createRange()
  before.selectNodeContents(container)
  before.setEnd(range.startContainer, range.startOffset)
  return before.toString().length
}

// The anchor text of a node: its text, a `<br>` as '\n'.
const textOf = (node: Node): string =>
  node instanceof Text
    ? node.data
    : node instanceof HTMLBRElement
      ? '\n'
      : Array.from(node.childNodes).map(textOf).join('')

// The offset of a point of the document in the anchor text of the blocks. A
// point between blocks goes to the start of the block after it (`from`) or
// the end of the one before it (`to`).
const offsetOfPoint = (
  blocks: ReadonlyArray<Element>,
  node: Node,
  offset: number,
  side: 'from' | 'to',
): number => {
  let start = 0
  let previousEnd = 0
  for (const block of blocks) {
    const length = textOf(block).length
    const inside = document.createRange()
    inside.selectNodeContents(block)
    const where = inside.comparePoint(node, offset)
    if (where === 0) {
      const before = document.createRange()
      before.selectNodeContents(block)
      before.setEnd(node, offset)
      return start + textOf(before.cloneContents()).length
    }
    if (where < 0) {
      return side === 'from' ? start : previousEnd
    }
    previousEnd = start + length
    start += length + 1
  }
  return previousEnd
}

// NOTE: `Option.none` when the selection is not in a commentable text (leave
// what is known alone), `Some(None)` when it is empty inside one (clear it).
export const readCommentSelection = (): Option.Option<
  Option.Option<CommentSelection>
> => {
  const selection = window.getSelection()
  if (selection === null || selection.rangeCount === 0) {
    return Option.none()
  }
  const range = selection.getRangeAt(0)
  const container = containerOf(range.startContainer)
  if (container === null) {
    return Option.none()
  }
  if (selection.isCollapsed) {
    return Option.some(Option.none())
  }
  if (containerOf(range.endContainer) !== container) {
    return Option.none()
  }
  const blocks = Array.from(container.querySelectorAll(BLOCK_SELECTOR))
  const from =
    blocks.length === 0
      ? plainOffset(container, range)
      : offsetOfPoint(blocks, range.startContainer, range.startOffset, 'from')
  const quoted =
    blocks.length === 0
      ? range.toString().slice(0, MAX_QUOTED)
      : anchorTextOf(blocks)
          .slice(
            from,
            offsetOfPoint(blocks, range.endContainer, range.endOffset, 'to'),
          )
          .slice(0, MAX_QUOTED)
  if (quoted.trim() === '') {
    return Option.some(Option.none())
  }
  const entries = container.getAttribute(`data-${COMMENT_ENTRIES}`) ?? ''
  return Option.some(
    Option.some({
      sectionId: container.getAttribute(`data-${COMMENT_SECTION}`) ?? '',
      itemId: container.getAttribute(`data-${COMMENT_ITEM}`) ?? '',
      entryPath: entries === '' ? [] : entries.split('/'),
      from,
      to: from + quoted.length,
      quoted,
    }),
  )
}
