import { Option, Schema } from 'effect'

import { IMAGE_ROUTE, ImageChunkRead } from '@case-desk/domain'

import { type ImageContext, imageReadQuery } from './spec'

// NOTE: Reading an image back. The route answers one chunk at a
// time as base64 text; the browser decodes it, joins the chunks and makes an
// object URL for an `<img>`. The request carries the session cookie, so the
// route authorizes it like the RPC (D5): the image must be referenced by the
// version named in the query (`context`): the working copy on the drafting
// screen, the draft number in the read-only draft view, the revision number
// for a revision.

export type ImageSource = Readonly<{
  imageId: string
  reportId: string
  context: ImageContext
}>

export type LoadedImage = Readonly<{
  blob: Blob
  mime: ImageChunkRead['mime']
  chunks: number
}>

const decodeChunk = Schema.decodeUnknownOption(ImageChunkRead)

export const base64ToBytes = (text: string): Uint8Array<ArrayBuffer> => {
  // NOTE: the native decoder where the browser has it (fast), `atob` if not.
  const native: unknown = Reflect.get(Uint8Array, 'fromBase64')
  if (typeof native === 'function') {
    const bytes: unknown = Reflect.apply(native, Uint8Array, [text])
    if (bytes instanceof Uint8Array) {
      return Uint8Array.from(bytes)
    }
  }
  const binary = atob(text)
  return Uint8Array.from(binary, character => character.codePointAt(0) ?? 0)
}

const chunkUrl = (source: ImageSource, index: number): string => {
  const query = imageReadQuery(source.reportId, source.context)
  return `${IMAGE_ROUTE}/${encodeURIComponent(source.imageId)}/${index}?${query}`
}

const fetchChunk = async (
  source: ImageSource,
  index: number,
  signal: AbortSignal,
): Promise<Option.Option<ImageChunkRead>> => {
  const response = await fetch(chunkUrl(source, index), { signal })
  if (!response.ok) {
    return Option.none()
  }
  const body: unknown = await response.json().catch(() => undefined)
  return decodeChunk(body)
}

export const loadImage = async (
  source: ImageSource,
  signal: AbortSignal,
): Promise<Option.Option<LoadedImage>> => {
  const first = await fetchChunk(source, 0, signal)
  if (Option.isNone(first)) {
    return Option.none()
  }
  const { chunks, mime } = first.value
  const rest = await Promise.all(
    Array.from({ length: chunks - 1 }, (_, at) =>
      fetchChunk(source, at + 1, signal),
    ),
  )
  const all = [first, ...rest]
  if (!all.every(Option.isSome)) {
    return Option.none()
  }
  return Option.some({
    blob: new Blob(
      all.map(chunk => base64ToBytes(chunk.value.base64)),
      { type: mime },
    ),
    mime,
    chunks,
  })
}
