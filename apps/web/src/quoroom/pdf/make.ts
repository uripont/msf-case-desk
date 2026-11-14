import { Effect } from 'effect'

import { type Built, imagesOf } from './source'

// NOTE: Making a file from a described document and handing it to the
// browser (stage 8). The PDF library is imported here, when first needed.

export type Made = Readonly<{ name: string; bytes: Uint8Array }>

export const renderBuilt = (reportId: string, built: Built) =>
  Effect.gen(function* () {
    const images = yield* imagesOf(reportId, built)
    const { renderDocument } = yield* Effect.tryPromise(
      () => import('./render'),
    )
    const bytes = yield* Effect.tryPromise(() =>
      renderDocument(built.description, images),
    )
    return { name: built.fileName, bytes } satisfies Made
  })

export const saveFile = (
  name: string,
  bytes: Uint8Array<ArrayBuffer>,
  mime: string,
) =>
  Effect.sync(() => {
    const url = URL.createObjectURL(new Blob([bytes], { type: mime }))
    const link = document.createElement('a')
    link.href = url
    link.download = name
    link.hidden = true
    document.body.append(link)
    link.click()
    link.remove()
    setTimeout(() => URL.revokeObjectURL(url), 10_000)
  })
