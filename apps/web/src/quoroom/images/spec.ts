import { Schema } from 'effect'
import { CustomElement } from 'foldkit'

// NOTE: The binding of the image element, with no logic in it, so a Foldkit
// view can render the tag. The element class is in `figureImage.ts`, which
// registers it when imported.
export const IMAGE_TAG = 'quoroom-image'

export const imageElement = CustomElement.define({
  tag: IMAGE_TAG,
  properties: {
    imageId: Schema.String,
    report: Schema.String,
    // NOTE: `imageContextToken`; empty reads the working copy.
    context: Schema.String,
    alt: Schema.String,
  },
  events: {},
})

// NOTE: The version an image is read through (D5). The server authorizes the
// read through the named version and serves the image only if that version
// references it: the author's working copy on the drafting screen, a shared
// draft in the read-only draft view, a revision in a reviewer's view. The
// element takes it as a short text (`working_copy`, `draft:3`, `revision:2`).
export type ImageContext =
  | Readonly<{ kind: 'working_copy' }>
  | Readonly<{ kind: 'draft'; draft: number }>
  | Readonly<{ kind: 'revision'; revision: number }>

export const WORKING_COPY_CONTEXT: ImageContext = { kind: 'working_copy' }

export const imageContextToken = (context: ImageContext): string =>
  context.kind === 'draft'
    ? `draft:${context.draft}`
    : context.kind === 'revision'
      ? `revision:${context.revision}`
      : 'working_copy'

// NOTE: An empty or unknown token is the working copy, the drafting screen's
// context, so a screen that names nothing keeps reading its own working copy.
export const parseImageContext = (token: string): ImageContext => {
  const [kind, number] = token.split(':')
  const n = Number(number)
  if (kind === 'draft' && Number.isInteger(n) && n >= 0) {
    return { kind: 'draft', draft: n }
  }
  if (kind === 'revision' && Number.isInteger(n) && n >= 1) {
    return { kind: 'revision', revision: n }
  }
  return WORKING_COPY_CONTEXT
}

// NOTE: The query string of a read (`ImageReadQuery`).
export const imageReadQuery = (
  reportId: string,
  context: ImageContext,
): string => {
  const query = new URLSearchParams({ context: context.kind, report: reportId })
  if (context.kind === 'draft') {
    query.set('draft', String(context.draft))
  } else if (context.kind === 'revision') {
    query.set('revision', String(context.revision))
  }
  return query.toString()
}
