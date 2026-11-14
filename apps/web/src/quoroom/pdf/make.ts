import { Effect } from 'effect'

import { type Built, type ImageCache, imagesOf } from './source'

// NOTE: Making a file from a described document and handing it to the
// browser (stage 8). The PDF library is imported here, when first needed.

export type Made = Readonly<{ name: string; bytes: Uint8Array<ArrayBuffer> }>

export const renderBuilt = (
  reportId: string,
  built: Built,
  cache?: ImageCache,
) =>
  Effect.gen(function* () {
    const images = yield* imagesOf(reportId, built, cache)
    const { renderDocument } = yield* Effect.tryPromise(
      () => import('./render'),
    )
    const bytes = yield* Effect.tryPromise(() =>
      renderDocument(built.description, images),
    )
    return { name: built.fileName, bytes } satisfies Made
  })

// NOTE: The file is made from its parts, so a zip is never copied into one
// big array first.
export const saveFile = (
  name: string,
  parts: ReadonlyArray<Uint8Array<ArrayBuffer>>,
  mime: string,
) =>
  Effect.sync(() => {
    const url = URL.createObjectURL(new Blob([...parts], { type: mime }))
    const link = document.createElement('a')
    link.href = url
    link.download = name
    link.hidden = true
    document.body.append(link)
    link.click()
    link.remove()
    setTimeout(() => URL.revokeObjectURL(url), 10_000)
  })
