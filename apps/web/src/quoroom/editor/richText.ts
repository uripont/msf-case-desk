import { Option, Result } from 'effect'

import {
  EMPTY_RICH_TEXT,
  type RichTextDoc,
  canonicalRichText,
  decodeRichText,
  offsetsOfProseMirrorRange,
} from '@case-desk/domain'

// NOTE: What crosses between the editor and the Model is a string of canonical
// JSON of the strict schema. Nothing else is ever stored (D3): the editor's own
// output is decoded by `decodeRichText`, which refuses an unknown node, mark or
// attribute, and then made canonical, so the string is the same for the same
// document whatever the editor did to produce it.

export const serializeRichText = (doc: RichTextDoc): string =>
  JSON.stringify(canonicalRichText(doc))

export const EMPTY_RICH_TEXT_JSON = serializeRichText(EMPTY_RICH_TEXT)

export const normaliseEditorJson = (
  json: unknown,
): Result.Result<RichTextDoc, string> =>
  Result.mapBoth(decodeRichText(json), {
    onFailure: problems =>
      problems[0] === undefined
        ? 'The text could not be read.'
        : `${problems[0].path.join('.')}: ${problems[0].message}`,
    onSuccess: canonicalRichText,
  })

export const parseRichTextJson = (
  content: string,
): Option.Option<RichTextDoc> =>
  Result.match(
    Result.try({
      try: (): unknown => JSON.parse(content),
      catch: () => 'invalid',
    }),
    {
      onFailure: () => Option.none(),
      onSuccess: parsed =>
        Result.match(normaliseEditorJson(parsed), {
          onFailure: () => Option.none(),
          onSuccess: Option.some,
        }),
    },
  )

export const richTextForItem = (maybeDoc: Option.Option<RichTextDoc>): string =>
  Option.match(maybeDoc, {
    onNone: () => EMPTY_RICH_TEXT_JSON,
    onSome: serializeRichText,
  })

// NOTE: The anchor of the editor's selection, in the text offsets shared with
// the read-only view (`richtext-offsets.ts` in the domain), from the editor's
// JSON and its ProseMirror positions. `None` when the document is not valid.
export const selectionAnchor = (
  json: unknown,
  pmFrom: number,
  pmTo: number,
): Option.Option<{ from: number; to: number; text: string }> =>
  Result.match(normaliseEditorJson(json), {
    onFailure: () => Option.none(),
    onSuccess: doc => {
      const anchor = offsetsOfProseMirrorRange(doc, pmFrom, pmTo)
      return Option.some({
        from: anchor.from,
        to: anchor.to,
        text: anchor.quoted,
      })
    },
  })
