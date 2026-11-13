import { Option } from 'effect'

import {
  type BlockNode,
  type InlineNode,
  type ListBlock,
  type RichTextDoc,
  richTextBlocks,
} from './richtext'

// NOTE: One coordinate scheme for comment anchors in rich text (iteration 3,
// D14, stages 4g and 6). The editor's selection and the read-only view's
// selection both report anchors in it, so the same words give the same
// `{ from, to, quoted }`.
//
// The anchor text of a document is `richTextBlocks(doc).join('\n')`:
// - every text block (paragraph, heading, figure CAPTION, in document order,
//   through lists and table cells) contributes its text; a hard break counts
//   as one '\n' character;
// - a single '\n' separates consecutive text blocks, including empty ones;
// - offsets are UTF-16 code unit offsets into that string (JavaScript
//   string indices), `from` inclusive, `to` exclusive.
//
// Captions are included because they are text a redacted reader sees and D14
// redacts. What is NOT in the anchor text: the image's `alt`, the "safe to
// share" label, "Image withheld" placeholders, bullets, numbers and any other
// label the views draw. The read-only view marks each text block with
// `data-rt-start` carrying the block's starting offset (`textBlockStarts`) so
// a DOM selection maps back without guessing.
//
// ProseMirror positions are a different scheme (they count node boundaries);
// `offsetsOfProseMirrorRange` converts them.

export type TextAnchor = Readonly<{
  from: number
  to: number
  quoted: string
}>

export const ANCHOR_SEPARATOR = '\n'

export const anchorText = (doc: RichTextDoc): string =>
  richTextBlocks(doc).join(ANCHOR_SEPARATOR)

// NOTE: The starting offset of every text block, in the order of
// `richTextBlocks`.
export const textBlockStarts = (doc: RichTextDoc): ReadonlyArray<number> => {
  const starts: Array<number> = []
  let next = 0
  for (const text of richTextBlocks(doc)) {
    starts.push(next)
    next += text.length + ANCHOR_SEPARATOR.length
  }
  return starts
}

const clampRange = (
  length: number,
  from: number,
  to: number,
): Readonly<{ from: number; to: number }> => {
  const low = Math.min(from, to)
  const high = Math.max(from, to)
  return {
    from: Math.min(Math.max(low, 0), length),
    to: Math.min(Math.max(high, 0), length),
  }
}

// (a) The quoted text of offsets, clipped to the document.
export const quotedText = (
  doc: RichTextDoc,
  from: number,
  to: number,
): string => {
  const text = anchorText(doc)
  const range = clampRange(text.length, from, to)
  return text.slice(range.from, range.to)
}

// ---- ProseMirror positions ----------------------------------------------------

// NOTE: ProseMirror sizes: text = its length, a hard break = 1, every other
// node = 2 (open and close) + its content. The Tiptap schema of the editor
// has exactly the domain's nodes (a figure has inline content), so positions
// over the domain document are the editor's positions.

const inlineSize = (nodes: ReadonlyArray<InlineNode> | undefined): number =>
  (nodes ?? []).reduce(
    (sum, node) => sum + (node.type === 'text' ? node.text.length : 1),
    0,
  )

type Block = BlockNode | ListBlock

// NOTE: Every text block with the ProseMirror position where its inline
// content starts, its text and its starting text offset, in document order.
type TextBlockPosition = Readonly<{
  pmStart: number
  text: string
  start: number
}>

const collect = (doc: RichTextDoc): ReadonlyArray<TextBlockPosition> => {
  const texts = richTextBlocks(doc)
  const out: Array<TextBlockPosition> = []
  let index = 0
  let start = 0
  const textBlock = (pmStart: number): void => {
    const text = texts[index] ?? ''
    out.push({ pmStart, text, start })
    start += text.length + ANCHOR_SEPARATOR.length
    index += 1
  }
  // Returns the position after the block.
  const walk = (block: Block, pos: number): number => {
    switch (block.type) {
      case 'paragraph':
      case 'heading':
      case 'figure':
        textBlock(pos + 1)
        return pos + 2 + inlineSize(block.content)
      case 'bulletList':
      case 'orderedList': {
        let inner = pos + 1
        for (const item of block.content) {
          let itemPos = inner + 1
          for (const child of item.content) {
            itemPos = walk(child, itemPos)
          }
          inner = itemPos + 1
        }
        return inner + 1
      }
      case 'table': {
        let rowPos = pos + 1
        for (const row of block.content) {
          let cellPos = rowPos + 1
          for (const cell of row.content) {
            let childPos = cellPos + 1
            for (const child of cell.content) {
              childPos = walk(child, childPos)
            }
            cellPos = childPos + 1
          }
          rowPos = cellPos + 1
        }
        return rowPos + 1
      }
    }
  }
  let pos = 0
  for (const block of doc.content) {
    pos = walk(block, pos)
  }
  return out
}

// Text offset of one ProseMirror position: a position inside a text block
// maps to its offset in that block; a position between blocks (or at a list,
// row or cell boundary) maps to the start (`from`) or the end (`to`) of the
// neighbouring text, and past the last block to the end of the text.
const offsetOfPosition = (
  blocks: ReadonlyArray<TextBlockPosition>,
  total: number,
  pmPosition: number,
  side: 'from' | 'to',
): number => {
  for (const block of blocks) {
    const end = block.pmStart + block.text.length
    if (pmPosition <= end) {
      if (pmPosition >= block.pmStart) {
        return block.start + (pmPosition - block.pmStart)
      }
      // NOTE: Between blocks: the end of a selection stops at the end of the
      // text before, the start of one begins at the text after.
      return side === 'to' && block.start > 0
        ? block.start - ANCHOR_SEPARATOR.length
        : block.start
    }
  }
  return total
}

// (b) ProseMirror-style positions over the document -> text offsets.
export const offsetsOfProseMirrorRange = (
  doc: RichTextDoc,
  pmFrom: number,
  pmTo: number,
): TextAnchor => {
  const blocks = collect(doc)
  const text = anchorText(doc)
  const low = Math.min(pmFrom, pmTo)
  const high = Math.max(pmFrom, pmTo)
  const from = offsetOfPosition(blocks, text.length, low, 'from')
  const to = offsetOfPosition(blocks, text.length, high, 'to')
  return { from, to, quoted: text.slice(from, to) }
}

// ---- Anchors on redacted text (D14) ---------------------------------------------

// NOTE: A reviewer's comment is written on the REDACTED text of one revision
// and its anchor is a position in that text (D14), never carried to a later
// revision. So the document given here must be that revision's redacted
// document. The replacement label of an alias changes the length of the text
// compared with the original, but the anchor was made on the redacted text, so
// nothing is recomputed: the anchor matches when `quoted` is exactly the text
// at `from..to`. When it does not (a stored document that changed, a client
// that mapped wrongly), `resolveAnchor` looks for `quoted` as a whole in the
// text and takes the occurrence nearest to `from`; no occurrence gives `None`
// (show the comment on its section without a highlight).
export const anchorMatches = (doc: RichTextDoc, anchor: TextAnchor): boolean =>
  anchor.from >= 0 &&
  anchor.from <= anchor.to &&
  anchor.to <= anchorText(doc).length &&
  quotedText(doc, anchor.from, anchor.to) === anchor.quoted

export const resolveAnchor = (
  doc: RichTextDoc,
  anchor: TextAnchor,
): Option.Option<TextAnchor> => {
  if (anchorMatches(doc, anchor)) {
    return Option.some(anchor)
  }
  if (anchor.quoted === '') {
    return Option.none()
  }
  const text = anchorText(doc)
  let best = -1
  let index = text.indexOf(anchor.quoted)
  while (index !== -1) {
    if (best === -1 || Math.abs(index - anchor.from) < Math.abs(best - anchor.from)) {
      best = index
    }
    index = text.indexOf(anchor.quoted, index + 1)
  }
  return best === -1
    ? Option.none()
    : Option.some({
        from: best,
        to: best + anchor.quoted.length,
        quoted: anchor.quoted,
      })
}
