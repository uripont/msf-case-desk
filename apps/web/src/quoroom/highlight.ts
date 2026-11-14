import { Array, Order, pipe } from 'effect'

// NOTE: Comment highlights in a read-only text. A comment on
// selected text carries `{ from, to, quoted }` in the text-offset scheme of
// the domain (`richtext-offsets.ts`). Pure: the text and the ranges go in, the
// parts of the text with the comments that cover each come out.

export type HighlightRange = Readonly<{
  id: string
  from: number
  to: number
  quoted: string
}>

export type TextPart = Readonly<{
  text: string
  commentIds: ReadonlyArray<string>
}>

// NOTE: The range as it sits in `text`: where it was made when the quoted text
// is still there, otherwise the occurrence of the quoted text nearest to it,
// and none when the text no longer holds it (the comment is then listed with
// its section and not highlighted).
export const resolveRange = (
  text: string,
  range: HighlightRange,
): HighlightRange | undefined => {
  if (
    range.from >= 0 &&
    range.from <= range.to &&
    range.to <= text.length &&
    text.slice(range.from, range.to) === range.quoted
  ) {
    return range
  }
  if (range.quoted === '') {
    return undefined
  }
  const starts = Array.filter(
    Array.makeBy(text.length, index => index),
    index => text.startsWith(range.quoted, index),
  )
  const best = Array.sort(
    starts,
    Order.mapInput(Order.Number, (index: number) =>
      Math.abs(index - range.from),
    ),
  )[0]
  return best === undefined
    ? undefined
    : { ...range, from: best, to: best + range.quoted.length }
}

// NOTE: `text` starts at `offset` in the anchor text. Parts are in order, with
// no gaps, and a part is only as long as the ranges that cover it agree on.
export const splitByHighlights = (
  text: string,
  offset: number,
  ranges: ReadonlyArray<HighlightRange>,
): ReadonlyArray<TextPart> => {
  const inside = Array.filter(
    ranges,
    range => range.to > offset && range.from < offset + text.length,
  )
  if (Array.isReadonlyArrayEmpty(inside)) {
    return text === '' ? [] : [{ text, commentIds: [] }]
  }
  const cuts = pipe(
    inside,
    Array.flatMap(range => [range.from - offset, range.to - offset]),
    Array.append(0),
    Array.append(text.length),
    Array.map(cut => Math.min(Math.max(cut, 0), text.length)),
    Array.dedupe,
    Array.sort(Order.Number),
  )
  return pipe(
    Array.zip(cuts, Array.drop(cuts, 1)),
    Array.map(([start, end]) => ({
      text: text.slice(start, end),
      commentIds: pipe(
        inside,
        Array.filter(
          range =>
            range.from - offset <= start && range.to - offset >= end,
        ),
        Array.map(range => range.id),
      ),
    })),
    Array.filter(part => part.text !== ''),
  )
}
