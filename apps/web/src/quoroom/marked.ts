import { Array } from 'effect'
import { Html, HtmlBuilder } from 'foldkit/html'

type Child = Html | string

import { markedParts } from '@case-desk/domain'

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
