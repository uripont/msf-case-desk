import { Array } from 'effect'
import { Html, HtmlBuilder } from 'foldkit/html'

type Child = Html | string

import { markedParts } from '@case-desk/domain'

import { type HighlightRange, splitByHighlights } from './highlight'

// NOTE: A text with the strings in `marks` highlighted, for the redacted
// preview (D14): every label that took the place of a name, and the placeholder
// of a withheld image. The highlight is a background and an underline, not
// colour alone, and carries a data attribute the tests and the browser check
// read. With no marks the text is returned as it is.
export const REPLACEMENT = 'redaction'

export const markedChildren = <M>(
  h: HtmlBuilder<M>,
  text: string,
  marks: ReadonlyArray<string>,
): ReadonlyArray<Child> =>
  marks.length === 0
    ? [text]
    : Array.map(markedParts(text, marks), part =>
        part.marked
          ? h.span(
              [
                h.DataAttribute(REPLACEMENT, 'replaced'),
                h.Class(
                  'bg-yellow-200 font-semibold text-msf-black underline decoration-2 underline-offset-2',
                ),
              ],
              [part.text],
            )
          : part.text,
      )

export const COMMENT_HIGHLIGHT = 'comment-highlight'

// NOTE: A text with the parts that comments are on marked (stage 6b): a
// background and an underline, not colour alone, and the IDs of the comments
// on the part in a data attribute. `offset` is where the text starts in the
// anchor text of its item; a redacted preview's marks still apply inside.
export const highlightedChildren = <M>(
  h: HtmlBuilder<M>,
  text: string,
  offset: number,
  ranges: ReadonlyArray<HighlightRange>,
  marks: ReadonlyArray<string>,
): ReadonlyArray<Child> =>
  ranges.length === 0
    ? markedChildren(h, text, marks)
    : Array.flatMap(splitByHighlights(text, offset, ranges), part =>
        part.commentIds.length === 0
          ? markedChildren(h, part.text, marks)
          : [
              h.span(
                [
                  h.DataAttribute(COMMENT_HIGHLIGHT, part.commentIds.join(' ')),
                  h.Class(
                    'bg-sky-100 underline decoration-sky-700 decoration-2 underline-offset-2',
                  ),
                ],
                markedChildren(h, part.text, marks),
              ),
            ],
      )
